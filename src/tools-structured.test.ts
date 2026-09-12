import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ViteMCP } from "@vitemcp/server";
import { registerTools } from "./tools.js";
import { SearchIndex } from "./search.js";
import type {
    BackendMutationResult,
    BackendReadResult,
    VaultBackend,
    VersionedNote,
} from "./vault-backend.js";
import { structuredNoteResultSchema } from "./note-contract.js";

const encoder = new TextEncoder();
const note: VersionedNote = {
    path: "note.md",
    bytes: encoder.encode("body"),
    version: "nv1.test",
    size: 4,
    ctime: 1,
    mtime: 2,
    conflicts: [],
    concurrency: "strict_winner_cas",
    backendState: { winnerRevision: "1-a" },
};

function backend(mutation: BackendMutationResult, read: BackendReadResult = { status: "ok", note }): VaultBackend {
    return {
        concurrency: "strict_winner_cas",
        init: async () => {},
        close: async () => {},
        readVersioned: async () => read,
        createVersioned: async () => mutation,
        replaceVersioned: async () => mutation,
        deleteVersioned: async () => mutation,
        moveVersioned: async () => mutation,
        readNote: async () => "body",
        writeNote: async () => true,
        deleteNote: async () => true,
        moveNote: async () => true,
        getMetadata: async () => null,
        listNotes: async () => [],
        listNotesWithMtime: async () => [],
    };
}

function toolsFor(vault: VaultBackend, index = new SearchIndex()) {
    const tools = new Map<string, any>();
    const server = {
        addTool(tool: any) {
            tools.set(tool.name, tool);
            return tool;
        },
    };
    registerTools(server as unknown as ViteMCP, vault, index, "TestVault");
    return tools;
}

async function call(tools: Map<string, any>, name: string, args: Record<string, unknown>) {
    const value = await tools.get(name).execute(args, {});
    assert.equal(structuredNoteResultSchema.safeParse(value.structuredContent).success, true);
    assert.equal(value.content.length, 1);
    assert.equal(value.content[0].type, "text");
    return value;
}

it("reuses JSON schemas for every tool while preserving Zod validation", async () => {
    const tools = toolsFor(backend({ status: "error", code: "BACKEND_UNAVAILABLE", effects: [] }));
    for (const tool of tools.values()) {
        const standard = tool.parameters["~standard"];
        assert.ok(standard.jsonSchema, `${tool.name} must bypass ViteMCP's per-request conversion`);
        const schema = standard.jsonSchema.input();
        assert.equal(schema.type, "object");
        assert.strictEqual(standard.jsonSchema.input(), schema);
        assert.strictEqual(standard.jsonSchema.output(), schema);
    }
    const validate = tools.get("list_notes").parameters["~standard"].validate;
    assert.deepEqual((await validate({ limit: "2" })).value, { limit: 2 });
    assert.ok((await validate({ limit: "not-a-number" })).issues.length);
});

describe("structured mutation outcomes", () => {
    for (const operation of ["create_note", "edit_note"] as const) {
        it(`indexes ${operation} from authoritative backend bytes and timestamp`, async () => {
            const index = new SearchIndex();
            let indexed: { path: string; content: string; mtime?: number } | undefined;
            index.update = (path, content, mtime) => { indexed = { path, content, mtime }; };
            const result = await call(
                toolsFor(backend({
                    status: "ok",
                    note: { ...note, bytes: encoder.encode("authoritative"), mtime: 123 },
                    effects: [{
                        kind: operation === "create_note" ? "note_created" : "note_updated",
                        path: "note.md",
                        completed: true,
                    }],
                }), index),
                operation,
                operation === "create_note"
                    ? { path: "note.md", content: "requested" }
                    : { path: "note.md", version: note.version, content: "requested", operation: "replace_all" },
            );
            assert.equal(result.structuredContent.status, "ok");
            assert.deepEqual(indexed, { path: "note.md", content: "authoritative", mtime: 123 });
        });
    }

    for (const backendNote of [undefined, { ...note, bytes: Uint8Array.from([0xff]) }]) {
        it(`marks committed content stale when the authoritative snapshot is ${backendNote ? "invalid Markdown" : "missing"}`, async () => {
            const result = await call(
                toolsFor(backend({
                    status: "ok",
                    note: backendNote,
                    effects: [{ kind: "note_created", path: "note.md", completed: true }],
                })),
                "create_note",
                { path: "note.md", content: "requested" },
            );
            assert.equal(result.structuredContent.status, "ok");
            assert.equal(result.structuredContent.result.indexFreshness, "stale");
            assert.deepEqual(result.structuredContent.effects.at(-1), {
                kind: "index_updated",
                path: "note.md",
                completed: false,
            });
        });
    }

    for (const state of ["ready", "building", "catching_up", "error"] as const) {
        it(`keeps mutation freshness monotonic from ${state}`, async () => {
            const index = new SearchIndex();
            index.setBuildStatus(state);
            const result = await call(
                toolsFor(backend({
                    status: "ok",
                    note,
                    effects: [{ kind: "note_created", path: "note.md", completed: true }],
                }), index),
                "create_note",
                { path: "note.md", content: "requested" },
            );
            assert.equal(result.structuredContent.result.indexFreshness, state === "ready" ? "current" : "stale");
            assert.equal(result.structuredContent.effects.at(-1).completed, true);
        });
    }

    it("marks freshness stale if the index stops being ready during maintenance", async () => {
        const index = new SearchIndex();
        const update = index.update.bind(index);
        index.update = (path, content, mtime) => {
            update(path, content, mtime);
            index.setBuildStatus("catching_up");
        };
        const result = await call(
            toolsFor(backend({
                status: "ok",
                note,
                effects: [{ kind: "note_created", path: "note.md", completed: true }],
            }), index),
            "create_note",
            { path: "note.md", content: "requested" },
        );
        assert.equal(result.structuredContent.result.indexFreshness, "stale");
    });

    it("keeps a committed vault mutation successful when index maintenance fails", async () => {
        const index = new SearchIndex();
        index.update = () => { throw new Error("index unavailable"); };
        const result = await call(
            toolsFor(backend({
                status: "ok",
                note: { ...note, version: "nv1.after" },
                effects: [{ kind: "note_created", path: "note.md", completed: true }],
            }), index),
            "create_note",
            { path: "note.md", content: "body" },
        );
        assert.equal(result.structuredContent.status, "ok");
        assert.equal(result.structuredContent.result.indexFreshness, "stale");
        assert.deepEqual(result.structuredContent.effects.at(-1), {
            kind: "index_updated",
            path: "note.md",
            completed: false,
        });
        assert.match(result.content[0].text, /index is not proven current/i);
    });

    it("keeps global freshness stale after a failed maintenance call", async () => {
        const index = new SearchIndex();
        const update = index.update.bind(index);
        index.update = () => { throw new Error("index unavailable"); };
        const failed = await call(
            toolsFor(backend({
                status: "ok",
                note,
                effects: [{ kind: "note_created", path: "first.md", completed: true }],
            }), index),
            "create_note",
            { path: "first.md", content: "body" },
        );
        assert.equal(failed.structuredContent.result.indexFreshness, "stale");
        assert.equal(index.status.state, "error");

        index.update = update;
        const later = await call(
            toolsFor(backend({
                status: "ok",
                note: { ...note, path: "second.md" },
                effects: [{ kind: "note_created", path: "second.md", completed: true }],
            }), index),
            "create_note",
            { path: "second.md", content: "body" },
        );
        assert.equal(later.structuredContent.result.indexFreshness, "stale");
        assert.deepEqual(index.listPaths(), ["second.md"]);
    });

    it("maps a post-commit CouchDB branch to committed_with_conflict", async () => {
        const result = await call(
            toolsFor(backend({
                status: "committed_with_conflict",
                note: { ...note, conflicts: ["2-other"] },
                effects: [{ kind: "note_created", path: "note.md", completed: true }],
            })),
            "create_note",
            { path: "note.md", content: "body" },
        );
        assert.equal(result.structuredContent.status, "committed_with_conflict");
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.recovery.strategy, "manual_reconcile");
    });

    it("does not remove an indexed note when a committed delete has a concurrent branch", async () => {
        const index = new SearchIndex();
        index.update("note.md", "authoritative winner", 2);
        const result = await call(
            toolsFor(backend({
                status: "committed_with_conflict",
                effects: [{ kind: "note_deleted", path: "note.md", completed: true }],
            }), index),
            "delete_note",
            { path: "note.md", version: note.version },
        );
        assert.equal(result.structuredContent.status, "committed_with_conflict");
        assert.equal(result.structuredContent.result.indexFreshness, "stale");
        assert.deepEqual(index.listPaths(), ["note.md"]);
        assert.deepEqual(result.structuredContent.effects.at(-1), {
            kind: "index_updated",
            path: "note.md",
            completed: false,
        });
        assert.equal(index.status.state, "error");
        assert.match(result.content[0].text, /index is not proven current/i);
    });

    it("does not project an indeterminate delete as authoritative absence", async () => {
        const index = new SearchIndex();
        index.update("note.md", "last known content", 1);
        const result = await call(
            toolsFor(backend({
                status: "indeterminate",
                effects: [{ kind: "note_deleted", path: "note.md", completed: true }],
            }), index),
            "delete_note",
            { path: "note.md", version: note.version },
        );
        assert.equal(result.structuredContent.status, "indeterminate");
        assert.deepEqual(index.listPaths(), ["note.md"]);
        assert.deepEqual(result.structuredContent.effects.at(-1), {
            kind: "index_updated",
            path: "note.md",
            completed: false,
        });
        assert.equal(index.status.state, "error");
    });

    it("preserves exact move effects for a partial result", async () => {
        const effects = [
            { kind: "destination_created" as const, path: "moved.md", completed: true },
            { kind: "source_deleted" as const, path: "note.md", completed: false },
        ];
        const result = await call(
            toolsFor(backend({ status: "partial", code: "STALE_VERSION", effects })),
            "move_note",
            { from: "note.md", to: "moved.md", version: note.version },
        );
        assert.equal(result.structuredContent.status, "partial");
        assert.equal(result.isError, true);
        assert.deepEqual(result.structuredContent.effects.slice(0, 2), effects);
        assert.equal(result.structuredContent.recovery.strategy, "read_then_retry");
        assert.deepEqual(result.structuredContent.effects.at(-1), {
            kind: "index_updated",
            path: "moved.md",
            completed: false,
        });
    });

    it("indexes a committed move from the backend result even when a pre-move read would fail", async () => {
        const index = new SearchIndex();
        let indexed: { path: string; content: string } | undefined;
        index.update = (path, content) => { indexed = { path, content }; };
        const result = await call(
            toolsFor(backend({
                status: "ok",
                note: { ...note, path: "moved.md", bytes: encoder.encode("committed body") },
                effects: [
                    { kind: "destination_created", path: "moved.md", completed: true },
                    { kind: "source_deleted", path: "note.md", completed: true },
                ],
            }, { status: "error", code: "BACKEND_UNAVAILABLE" }), index),
            "move_note",
            { from: "note.md", to: "moved.md", version: note.version },
        );
        assert.equal(result.structuredContent.status, "ok");
        assert.deepEqual(indexed, { path: "moved.md", content: "committed body" });
        assert.deepEqual(result.structuredContent.effects.at(-1), {
            kind: "index_updated",
            path: "moved.md",
            completed: true,
        });
    });

    it("does not remove a move source when a conflict leaves source absence unproven", async () => {
        const index = new SearchIndex();
        index.update("note.md", "source", 1);
        const result = await call(
            toolsFor(backend({
                status: "committed_with_conflict",
                note: { ...note, path: "moved.md", bytes: encoder.encode("destination") },
                effects: [
                    { kind: "destination_created", path: "moved.md", completed: true },
                    { kind: "source_deleted", path: "note.md", completed: true },
                ],
            }), index),
            "move_note",
            { from: "note.md", to: "moved.md", version: note.version },
        );
        assert.equal(result.structuredContent.result.indexFreshness, "stale");
        assert.deepEqual(index.listPaths(), ["moved.md", "note.md"]);
        assert.deepEqual(result.structuredContent.effects.slice(-2), [{
            kind: "index_updated",
            path: "moved.md",
            completed: true,
        }, {
            kind: "index_updated",
            path: "note.md",
            completed: false,
        }]);
        assert.equal(index.status.state, "error");
        assert.match(result.content[0].text, /index is not proven current/i);
    });

    it("marks unknown commit state indeterminate and warns against blind retry", async () => {
        const result = await call(
            toolsFor(backend({
                status: "indeterminate",
                effects: [{ kind: "note_created", path: "note.md", completed: false }],
            })),
            "create_note",
            { path: "note.md", content: "body" },
        );
        assert.equal(result.structuredContent.status, "indeterminate");
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.recovery.strategy, "read_then_retry");
        assert.match(result.structuredContent.warning, /Do not repeat/i);
    });

    it("maps stale versions to a conflict without leaking a replacement version", async () => {
        const result = await call(
            toolsFor(backend({
                status: "conflict",
                code: "STALE_VERSION",
                effects: [{ kind: "note_deleted", path: "note.md", completed: false }],
            })),
            "delete_note",
            { path: "note.md", version: "nv1.stale" },
        );
        assert.equal(result.structuredContent.status, "conflict");
        assert.equal(result.structuredContent.error.code, "STALE_VERSION");
        assert.equal("result" in result.structuredContent, false);
    });
});

it("serves schema-valid indexed search without vault reads, preserving limits and notices", async () => {
    const { FullTextIndex } = await import("./full-text-search.js");
    const { structuredSearchResultSchema } = await import("./search-contract.js");
    const { Ajv } = await import("ajv");
    const { default: addFormats } = await import("ajv-formats");
    const db = await FullTextIndex.open(":memory:");
    const index = new SearchIndex(db);
    try {
        for (let i = 0; i < 55; i++) index.update(`folder/${i}.md`, "---\naliases: [Alternate]\ntags: [topic]\n---\n# Example\n## Detail\nsearchable content", 1000);
        index.update("other.md", "unrelated");
        const vault = backend({ status: "error", code: "BACKEND_UNAVAILABLE", effects: [] });
        for (const key of ["readNote", "readVersioned", "getMetadata", "listNotes", "listNotesWithMtime"] as const) {
            vault[key] = async () => { throw new Error("unexpected vault access"); };
        }
        const tool = toolsFor(vault, index).get("search_notes");
        const schema = tool.outputSchema["~standard"].jsonSchema.output();
        assert.equal(schema.type, "object");
        const ajv = new Ajv();
        addFormats(ajv);
        const validate = ajv.compile(schema);
        const callSearch = async (args: Record<string, unknown>) => {
            const output = await tool.execute(args, {});
            assert.ok(validate(output.structuredContent), JSON.stringify(validate.errors));
            assert.ok(structuredSearchResultSchema.safeParse(output.structuredContent).success);
            return output;
        };
        const normal = await callSearch({ query: "searchable" });
        assert.equal(normal.isError, false);
        assert.equal(normal.structuredContent.result.returnedCount, 10);
        const hit = normal.structuredContent.result.hits[0];
        assert.deepEqual({ title: hit.title, aliases: hit.aliases, tags: hit.tags }, { title: "Example", aliases: ["Alternate"], tags: ["topic"] });
        assert.equal(hit.modified, "1970-01-01T00:00:01.000Z");
        assert.equal(hit.heading, "Detail");
        assert.equal(hit.matchedBy, "passage");
        assert.match(normal.content[0].text, /obsidian:\/\/open/);
        assert.equal((await callSearch({ query: "searchable", limit: 50 })).structuredContent.result.returnedCount, 50);
        for (const filters of [{ folder: "missing" }, { tag: "missing" }, { modified_after: "2026-01-01" }]) {
            assert.equal((await callSearch({ query: "searchable", ...filters })).structuredContent.result.returnedCount, 0);
        }
        assert.equal((await callSearch({ query: "unrelated" })).structuredContent.result.hits[0].modified, null);
        // "1" and "2024-02-30" are accepted by new Date() — they must not become a silent cutoff.
        for (const modified_after of ["bad date", "1", "2024-02-30", "2026-3-25"]) {
            const error = await callSearch({ query: "searchable", modified_after });
            assert.equal(error.isError, true, modified_after);
            assert.equal(error.structuredContent.error.code, "INVALID_SEARCH_INPUT", modified_after);
        }
        {
            const error = await callSearch({ query: "!!!" });
            assert.equal(error.isError, true);
            assert.equal(error.structuredContent.error.code, "INVALID_SEARCH_INPUT");
        }
        for (const state of ["building", "catching_up", "error"] as const) {
            index.setBuildStatus(state, 1, 2, "private backend details");
            const output = await callSearch({ query: "searchable" });
            assert.equal(output.structuredContent.notices.length, 1);
            assert.ok(output.content[0].text.startsWith(output.structuredContent.notices[0]));
            assert.doesNotMatch(JSON.stringify(output), /private backend/);
        }
        index.searchNotes = () => { throw new Error("SQL secret /private/vault"); };
        const error = await callSearch({ query: "searchable" });
        assert.equal(error.structuredContent.error.code, "SEARCH_FAILED");
        assert.equal(error.isError, true);
        assert.doesNotMatch(JSON.stringify(error), /SQL|secret|private/);
        for (const limit of [0, 51, 1.5]) assert.ok((await tool.parameters["~standard"].validate({ query: "x", limit })).issues);
    } finally { index.close(); }
});

it("logs only sanitized search failure stages when debug logging is enabled", async () => {
    const { FullTextIndex } = await import("./full-text-search.js");
    const index = new SearchIndex(await FullTextIndex.open(":memory:"));
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
        const tool = toolsFor(backend({ status: "error", code: "BACKEND_UNAVAILABLE", effects: [] }), index).get("search_notes");
        await tool.execute({ query: "!!!" }, {});
        assert.deepEqual(errors, []);
        index.searchNotes = () => { throw new Error("SQL credentials /private/vault"); };
        const execution = await tool.execute({ query: "private query" }, {});
        assert.equal(execution.structuredContent.error.code, "SEARCH_FAILED");
        // Invalid indexed output must be distinguishable in logs without leaking Zod issues.
        index.searchNotes = () => [{ path: "private-note.md", mtime: 0, rank: NaN,
            matchedBy: "passage", snippet: "secret snippet", title: "private title", aliases: [], tags: [] }];
        const output = await tool.execute({ query: "private query" }, {});
        assert.equal(output.structuredContent.error.code, "SEARCH_FAILED");
        assert.deepEqual(errors, process.env.LOG_LEVEL === "debug" ? [
            ["[tool] search_notes failed (execution; details redacted)"],
            ["[tool] search_notes failed (output; details redacted)"],
        ] : []);
        assert.doesNotMatch(JSON.stringify({ errors, execution, output }), /SQL|credentials|private|secret snippet|NaN/);
    } finally {
        console.error = originalError;
        index.close();
    }
});

it("rejects non-ISO modified_after in list_notes instead of applying a silent cutoff", async () => {
    const notes = [
        { path: "old.md", mtime: Date.UTC(2024, 0, 1) },
        { path: "new.md", mtime: Date.UTC(2026, 0, 1) },
    ];
    const vault = { ...backend({ status: "error", code: "BACKEND_UNAVAILABLE", effects: [] }), listNotesWithMtime: async () => notes };
    const index = new SearchIndex();
    try {
        const listNotes = toolsFor(vault, index).get("list_notes");
        // new Date() accepts all of these; "1" would silently cut off at year 2001
        // and "2024-02-30" would roll over to 2024-03-01.
        for (const modified_after of ["1", "0", "2024-02-30", "2026-3-25", "bad date"]) {
            const output = await listNotes.execute({ modified_after }, {});
            assert.match(output, /^Invalid date format/, modified_after);
        }
        const filtered = await listNotes.execute({ modified_after: "2025-01-01" }, {});
        assert.match(filtered, /new\.md/);
        assert.doesNotMatch(filtered, /old\.md/);
    } finally {
        index.close();
    }
});
