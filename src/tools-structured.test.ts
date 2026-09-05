import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastMCP } from "fastmcp";
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
    registerTools(server as unknown as FastMCP, vault, index, "TestVault");
    return tools;
}

async function call(tools: Map<string, any>, name: string, args: Record<string, unknown>) {
    const value = await tools.get(name).execute(args, {});
    assert.equal(structuredNoteResultSchema.safeParse(value.structuredContent).success, true);
    assert.equal(value.content.length, 1);
    assert.equal(value.content[0].type, "text");
    return value;
}

describe("structured mutation outcomes", () => {
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
        assert.match(result.content[0].text, /index maintenance failed/i);
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
