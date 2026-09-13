import { Ajv } from "ajv";
import addFormats from "ajv-formats";
/**
 * E2E test: starts server in local mode, tests all tools via MCP protocol.
 * Includes restart test to verify index persistence and mtime diff sync.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { request as httpRequest } from "node:http";

const PORT = 9877;
const BASE = `http://localhost:${PORT}/mcp`;
const AUTH = "ci-test-token";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const NODE_BIN = process.execPath;

let server: ChildProcess;
let vaultDir: string;
let sessionId: string;
let serverLogs: string;
let lastInitResult: any = null;

// --- Helpers ---

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    try { return JSON.parse(raw); } catch {
        throw new Error(`Could not parse response: ${raw.slice(0, 200)}`);
    }
}

async function mcpCall(method: string, params: any, id = 1): Promise<any> {
    const resp = await fetch(BASE, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": `Bearer ${AUTH}`,
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return parseSSE(await resp.text());
}

async function callToolResult(name: string, args: any = {}): Promise<any> {
    const resp = await mcpCall("tools/call", { name, arguments: args });
    assert.ok(resp?.result, `Tool ${name} returned no result`);
    return resp.result;
}

async function callTool(name: string, args: any = {}): Promise<string> {
    const result = await callToolResult(name, args);
    const text = result?.content?.[0]?.text;
    assert.ok(text, `Tool ${name} returned no text content`);
    return text;
}

async function startServer(env: Record<string, string> = {}): Promise<void> {
    serverLogs = "";
    server = spawn(NODE_BIN, ["dist/main.js"], {
        env: { ...process.env, PORT: String(PORT), MCP_AUTH_TOKEN: AUTH, ...env },
        stdio: "pipe",
    });
    server.stdout?.on("data", (d) => { serverLogs += d.toString(); });
    server.stderr?.on("data", (d) => { serverLogs += d.toString(); });

    const start = Date.now();
    let lastError: unknown;
    while (Date.now() - start < 10000) {
        try {
            const resp = await fetch(BASE, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${AUTH}` },
                body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } } }),
            });
            if (resp.ok) {
                sessionId = resp.headers.get("mcp-session-id") ?? "";
                lastInitResult = parseSSE(await resp.text());
                assert.equal(
                    lastInitResult?.result?.protocolVersion,
                    MCP_PROTOCOL_VERSION,
                    "server should negotiate MCP protocol 2025-11-25",
                );
                assert.equal(lastInitResult?.result?.serverInfo?.version, PACKAGE_VERSION, "server should report the package version");

                const initialized = await fetch(BASE, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream",
                        "Authorization": `Bearer ${AUTH}`,
                        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
                        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
                    },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        method: "notifications/initialized",
                    }),
                });
                assert.equal(initialized.status, 202, "server should accept notifications/initialized");
                return;
            }
        } catch (error) {
            if (error instanceof assert.AssertionError) throw error;
            lastError = error;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Server did not start in time", { cause: lastError });
}

async function stopServer(): Promise<string> {
    if (!server) return "";
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    const logs = serverLogs;
    return logs;
}

// --- Setup / Teardown ---

before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "vault-e2e-"));
    await mkdir(join(vaultDir, "daily"), { recursive: true });
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeFile(join(vaultDir, "Welcome.md"), "---\ntitle: Welcome\ntags: [intro]\n---\n# Welcome\nHello world");
    await writeFile(join(vaultDir, "daily/2026-03-24.md"), "# Daily Note");
    await writeFile(join(vaultDir, "projects/test.md"), "See [[Welcome]]\n\n#project");

    await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault" });
    assert.equal(sessionId, "", "the server must not issue an MCP session ID");
});

after(async () => {
    await stopServer();
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

// --- Tool Tests ---

describe("E2E: Auth", () => {
    it("rejects unauthenticated requests", async () => {
        const resp = await fetch(BASE, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } } }),
        });
        assert.equal(resp.status, 401);
        assert.equal(resp.headers.get("www-authenticate"), `Bearer resource_metadata="http://localhost:${PORT}/.well-known/oauth-protected-resource"`);
    });

    it("keeps custom OAuth discovery routes mounted outside MCP authentication", async () => {
        const resource = await fetch(`http://localhost:${PORT}/.well-known/oauth-protected-resource`);
        assert.equal(resource.status, 200);
        assert.equal((await resource.json()).resource, `http://localhost:${PORT}`);
        const issuer = await fetch(`http://localhost:${PORT}/.well-known/oauth-authorization-server`);
        assert.equal(issuer.status, 200);
        assert.equal((await issuer.json()).token_endpoint, `http://localhost:${PORT}/oauth/token`);
    });

    it("checks browser origins even with a valid bearer token", async () => {
        for (const [origin, status] of [["http://localhost:4321", 200], ["https://attacker.example", 403]] as const) {
            const response = await fetch(BASE, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "Authorization": `Bearer ${AUTH}`,
                    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
                    "Origin": origin,
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 72, method: "tools/list", params: {} }),
            });
            assert.equal(response.status, status);
            const body = await response.text();
            if (status === 200) assert.ok(parseSSE(body).result.tools.some((tool: any) => tool.name === "read_note"));
        }
    });
});

describe("E2E: modern MCP", () => {
    async function modernCall(method: string, params: Record<string, unknown> = {}, token = AUTH) {
        const response = await fetch(BASE, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": `Bearer ${token}`,
                "MCP-Protocol-Version": "2026-07-28",
                "Mcp-Method": method,
                ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
            },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 71, method,
                params: {
                    ...params,
                    _meta: {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientInfo": { name: "modern-e2e", version: "1.0.0" },
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            }),
        });
        assert.equal(response.headers.get("mcp-session-id"), null);
        return response;
    }

    it("discovers and serves tools using the modern envelope without a session", async () => {
        const discovery = await modernCall("server/discover");
        const discovered = parseSSE(await discovery.text());
        assert.equal(discovery.status, 200, JSON.stringify(discovered));
        assert.ok(discovered.result.supportedVersions.includes("2026-07-28"));
        assert.equal(discovered.result._meta["io.modelcontextprotocol/serverInfo"].version, PACKAGE_VERSION);

        const listing = await modernCall("tools/list");
        const listed = parseSSE(await listing.text());
        assert.equal(listing.status, 200, JSON.stringify(listed));
        assert.ok(listed.result.tools.some((tool: any) => tool.name === "read_note" && tool.outputSchema));

        const read = await modernCall("tools/call", { name: "read_note", arguments: { path: "Welcome.md" } });
        const result = parseSSE(await read.text());
        assert.equal(read.status, 200, JSON.stringify(result));
        assert.equal(result.result.resultType, "complete");
        assert.equal(result.result.structuredContent.status, "ok");
        assert.equal(result.result.structuredContent.result.markdown, "---\ntitle: Welcome\ntags: [intro]\n---\n# Welcome\nHello world");

        const missing = await modernCall("tools/call", { name: "read_note", arguments: { path: "missing.md" } });
        const failure = parseSSE(await missing.text());
        assert.equal(missing.status, 200);
        assert.equal(failure.result.isError, true);
        assert.equal(failure.result.structuredContent.error.code, "NOTE_NOT_FOUND");
    });

    it("authenticates every modern request, including after successful discovery", async () => {
        assert.equal((await modernCall("server/discover")).status, 200);
        const denied = await modernCall("tools/list", {}, "wrong-token");
        assert.equal(denied.status, 401);
        assert.equal(denied.headers.get("www-authenticate"), `Bearer resource_metadata="http://localhost:${PORT}/.well-known/oauth-protected-resource"`);
    });
});

describe("E2E: structured search", () => {
    for (const protocol of [MCP_PROTOCOL_VERSION, "2026-07-28"]) {
        it(`returns structured hits, empty results and safe errors (${protocol})`, async () => {
            const call = async (method: string, params: Record<string, unknown>) => {
                const response = await fetch(BASE, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                        "Authorization": `Bearer ${AUTH}`, "MCP-Protocol-Version": protocol,
                        "Mcp-Method": method,
                        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
                    },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 77, method, params: {
                        ...params,
                        ...(protocol === "2026-07-28" ? { _meta: {
                            "io.modelcontextprotocol/protocolVersion": protocol,
                            "io.modelcontextprotocol/clientInfo": { name: "search-e2e", version: "1.0" },
                            "io.modelcontextprotocol/clientCapabilities": {},
                        } } : {}),
                    } }),
                });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get("mcp-session-id"), null);
                return parseSSE(await response.text()).result;
            };
            const listed = await call("tools/list", {});
            for (const [name, kind] of [["list_notes", "notes"], ["list_folders", "folders"], ["list_tags", "tags"]]) {
                const ajv = new Ajv(); addFormats(ajv);
                const validate = ajv.compile(listed.tools.find((tool: any) => tool.name === name).outputSchema);
                const output = await call("tools/call", { name, arguments: name === "list_notes" ? { limit: 1 } : {} });
                assert.ok(validate(output.structuredContent), JSON.stringify(validate.errors));
                assert.equal(output.structuredContent.result.kind, kind);
                assert.ok(output.structuredContent.result.entries.length > 0);
                if (name === "list_notes") {
                    assert.equal(output.structuredContent.result.returnedCount, 1);
                    assert.equal(output.structuredContent.result.truncated, true);
                    for (const limit of [-1, 0, 1.5, 1001, "not-a-number"]) {
                        const rejected = await call("tools/call", { name, arguments: { limit } });
                        assert.equal(rejected.isError, true, JSON.stringify(rejected));
                        assert.equal(rejected.structuredContent, undefined);
                        assert.match(rejected.content[0].text, /limit/i);
                    }
                    for (const args of [{ name: "nonexistentxyzzy" }, { modified_after: "private-invalid" }]) {
                        const response = await call("tools/call", { name, arguments: args });
                        assert.ok(validate(response.structuredContent));
                        if (args.name) assert.equal(response.structuredContent.result.total, 0);
                        else assert.equal(response.structuredContent.error.code, "INVALID_LIST_INPUT");
                        assert.doesNotMatch(JSON.stringify(response), /private-invalid|Vault is empty/);
                    }
                }
            }

            const schema = listed.tools.find((tool: any) => tool.name === "search_notes").outputSchema;
            assert.equal(schema.type, "object");
            const ajv = new Ajv();
            addFormats(ajv);
            const validate = ajv.compile(schema);
            for (const args of [
                { query: "welcome" }, { query: "nonexistentxyzzy" },
                { query: "!!!" }, { query: "welcome", modified_after: "invalid-private-date" },
            ]) {
                const output = await call("tools/call", { name: "search_notes", arguments: args });
                assert.ok(validate(output.structuredContent), JSON.stringify(validate.errors));
                if (args.query === "!!!" || args.modified_after) {
                    assert.equal(output.isError, true);
                    assert.equal(output.structuredContent.error.code, "INVALID_SEARCH_INPUT");
                    assert.doesNotMatch(JSON.stringify(output), /invalid-private-date|SQLITE/);
                } else {
                    assert.equal(output.isError, false);
                    const { hits, returnedCount } = output.structuredContent.result;
                    assert.equal(returnedCount, hits.length);
                    if (args.query === "welcome") {
                        assert.equal(hits[0].path, "Welcome.md");
                        assert.equal(typeof hits[0].rank, "number");
                        assert.equal(hits[0].title, "Welcome");
                        assert.ok(hits[0].tags.includes("intro"));
                        assert.match(hits[0].deepLink, /^obsidian:\/\/open/);
                        assert.match(output.content[0].text, /Welcome.md/);
                    } else {
                        assert.deepEqual(hits, []);
                        assert.match(output.content[0].text, /No notes found/);
                    }
                }
            }
        });
    }
});

describe("E2E: request-body limit", () => {
    for (const protocol of [MCP_PROTOCOL_VERSION, "2026-07-28"]) {
        it(`accepts 4 MiB and rejects one byte more (${protocol})`, async () => {
            const path = `body-limit-${protocol}.md`;
            const request = {
                jsonrpc: "2.0", id: 73, method: "tools/call",
                params: {
                    name: "create_note",
                    arguments: { path, content: "" },
                    ...(protocol === "2026-07-28" ? {
                        _meta: {
                            "io.modelcontextprotocol/protocolVersion": protocol,
                            "io.modelcontextprotocol/clientInfo": { name: "body-limit-e2e", version: "1.0.0" },
                            "io.modelcontextprotocol/clientCapabilities": {},
                        },
                    } : {}),
                },
            };
            const limit = 4 * 1024 * 1024;
            // ASCII content makes the full serialized request exactly the limit.
            const content = "x".repeat(limit - Buffer.byteLength(JSON.stringify(request)));
            const send = async (content: string) => {
                request.params.arguments.content = content;
                return fetch(BASE, {
                    method: "POST",
                    headers: {
                        // The body reader closes rejected uploads; do not pool their sockets.
                        "Connection": "close",
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream",
                        "Authorization": `Bearer ${AUTH}`,
                        "MCP-Protocol-Version": protocol,
                        "Mcp-Method": "tools/call",
                        "Mcp-Name": "create_note",
                    },
                    body: JSON.stringify(request),
                });
            };
            // The server rejects an oversized Content-Length before reading the body and
            // closes the socket as soon as that 400 flushes. When the teardown beats the
            // upload the client sees EPIPE, or an RST that discards the response body,
            // instead of the rejection. Retry: a rejected request writes nothing.
            const sendRejected = async (content: string) => {
                for (let attempt = 2; ; attempt--) {
                    try {
                        const response = await send(content);
                        return { status: response.status, payload: await response.json() as any };
                    } catch (error) {
                        if (attempt === 0) throw error;
                    }
                }
            };
            try {
                const rejected = await sendRejected(content + "x");
                assert.equal(rejected.status, 400);
                assert.equal(rejected.payload.error_description, "Request body exceeds 4 MiB");
                assert.equal(existsSync(join(vaultDir, path)), false, "oversized requests must not write a note");

                const accepted = await send(content);
                assert.equal(Buffer.byteLength(JSON.stringify(request)), limit);
                assert.equal(accepted.status, 200);
                const result = parseSSE(await accepted.text()).result;
                assert.equal(result.structuredContent.status, "ok");
                assert.equal(readFileSync(join(vaultDir, path), "utf8"), content);
            } finally {
                await rm(join(vaultDir, path), { force: true });
            }
        });
    }
});

describe("E2E: list_notes", () => {
    it("lists all notes", async () => {
        const text = await callTool("list_notes");
        assert.ok(text.includes("Welcome.md"));
        assert.ok(text.includes("daily/2026-03-24.md"));
        assert.ok(text.includes("projects/test.md"));
    });

    it("filters by folder", async () => {
        const text = await callTool("list_notes", { folder: "daily" });
        assert.ok(text.includes("2026-03-24.md"));
        assert.ok(!text.includes("Welcome.md"));
    });

    it("sorts by modified with limit", async () => {
        const text = await callTool("list_notes", { sort_by: "modified", limit: 2 });
        assert.ok(text.includes("more"));
    });

    it("filters by tag", async () => {
        const text = await callTool("list_notes", { tag: "intro" });
        assert.ok(text.includes("Welcome.md"));
        assert.ok(!text.includes("projects/test.md"));
    });
});

describe("E2E: read_note", () => {
    it("advertises strict schemas and returns structured canonical Markdown", async () => {
        const listed = await mcpCall("tools/list", {});
        const tools: any[] = listed.result.tools;
        const names = tools.map((tool) => tool.name);
        assert.ok(!names.includes("write_note"));
        for (const name of ["read_note", "get_note_metadata", "create_note", "edit_note", "delete_note", "move_note"]) {
            const tool = tools.find((candidate) => candidate.name === name);
            assert.equal(tool.outputSchema.type, "object", name + " must advertise an object-root output schema");
            assert.equal(tool.outputSchema.anyOf.length, 6, name + " must advertise all six status variants");
            assert.deepEqual(
                tool.outputSchema.anyOf.map((variant: any) => variant.properties.status.const),
                ["ok", "conflict", "committed_with_conflict", "partial", "indeterminate", "error"],
            );
            assert.ok(tool.outputSchema.anyOf.every((variant: any) => variant.additionalProperties === false));
        }
        const result = await callToolResult("read_note", { path: "Welcome.md" });
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.status, "ok");
        assert.equal(result.structuredContent.result.markdown.includes("Hello world"), true);
        assert.match(result.structuredContent.result.version, /^nv1\./);
        assert.equal(result.structuredContent.result.concurrency, "best_effort");
        assert.ok(result.content[0].text.startsWith("---\ntitle: Welcome"));
        assert.ok(result.content[0].text.includes("obsidian://open"));
    });

    it("returns schema-valid structured errors with isError", async () => {
        const result = await callToolResult("read_note", { path: "missing.md" });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.status, "error");
        assert.equal(result.structuredContent.error.code, "NOTE_NOT_FOUND");
        assert.equal(result.structuredContent.recovery.strategy, "change_request");
    });

    it("does not expose non-UTF-8 backend bytes as public note content", async () => {
        await writeFile(join(vaultDir, "invalid-utf8.md"), Buffer.from([0xff, 0xfe]));
        const result = await callToolResult("read_note", { path: "invalid-utf8.md" });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.status, "error");
        assert.equal(result.structuredContent.error.code, "INTERNAL_ERROR");
        assert.equal("result" in result.structuredContent, false);
    });
});

describe("E2E: create_note", () => {
    it("creates only when absent", async () => {
        const result = await callToolResult("create_note", { path: "ci-test.md", content: "# CI Test\nWritten by e2e" });
        assert.equal(result.structuredContent.status, "ok");
        assert.ok(existsSync(join(vaultDir, "ci-test.md")));
        const conflict = await callToolResult("create_note", { path: "ci-test.md", content: "overwrite" });
        assert.equal(conflict.isError, true);
        assert.equal(conflict.structuredContent.status, "conflict");
        assert.equal(conflict.structuredContent.error.code, "DESTINATION_EXISTS");
    });
});

describe("E2E: edit_note", () => {
    async function version(path: string): Promise<string> {
        return (await callToolResult("read_note", { path })).structuredContent.result.version;
    }

    it("applies exact append and rejects stale versions", async () => {
        const old = await version("Welcome.md");
        const result = await callToolResult("edit_note", { path: "Welcome.md", version: old, operation: "append", content: "Appended line" });
        assert.equal(result.structuredContent.status, "ok");
        const stale = await callToolResult("edit_note", { path: "Welcome.md", version: old, operation: "append", content: "bad" });
        assert.equal(stale.structuredContent.status, "conflict");
        assert.equal(stale.structuredContent.error.code, "STALE_VERSION");
        assert.equal(stale.structuredContent.recovery.strategy, "read_then_retry");
    });

    it("prepends body without inserting a newline", async () => {
        const current = await version("Welcome.md");
        const result = await callToolResult("edit_note", { path: "Welcome.md", version: current, operation: "prepend_body", content: "Prepended line" });
        assert.equal(result.structuredContent.status, "ok");
        const read = await callToolResult("read_note", { path: "Welcome.md" });
        assert.ok(read.structuredContent.result.markdown.includes("---\nPrepended line# Welcome"));
    });

    it("replaces exactly once and reports ambiguity", async () => {
        let current = await version("Welcome.md");
        const result = await callToolResult("edit_note", { path: "Welcome.md", version: current, operation: "replace_once", old_text: "Hello world", content: "Goodbye world" });
        assert.equal(result.structuredContent.result.replacements, 1);
        current = await version("Welcome.md");
        const ambiguous = await callToolResult("edit_note", { path: "Welcome.md", version: current, operation: "replace_once", old_text: "e", content: "x" });
        assert.equal(ambiguous.structuredContent.error.code, "LITERAL_AMBIGUOUS");
    });
});

describe("E2E: list_folders", () => {
    it("lists all folders with counts", async () => {
        const text = await callTool("list_folders");
        assert.ok(text.includes("daily"));
        assert.ok(text.includes("projects"));
    });
});

describe("E2E: list_tags", () => {
    it("lists all tags with counts", async () => {
        const text = await callTool("list_tags");
        assert.ok(text.includes("intro"));
        assert.ok(text.includes("project"));
    });
});

describe("E2E: get_note_metadata", () => {
    it("returns structured metadata, backlinks, freshness, and no content", async () => {
        const result = await callToolResult("get_note_metadata", { path: "Welcome.md" });
        const metadata = result.structuredContent.result;
        assert.ok(metadata.tags.includes("intro"));
        assert.ok(metadata.backlinks.includes("projects/test.md"));
        assert.ok(["current", "building"].includes(metadata.indexFreshness));
        assert.equal("markdown" in metadata, false);
        assert.match(metadata.version, /^nv1\./);
        const outgoing = await callToolResult("get_note_metadata", { path: "projects/test.md" });
        assert.ok(outgoing.structuredContent.result.outgoingLinks.includes("Welcome"));
    });
});

describe("E2E: move_note", () => {
    it("moves a note across folders", async () => {
        const read = await callToolResult("read_note", { path: "ci-test.md" });
        const result = await callToolResult("move_note", {
            from: "ci-test.md", to: "archive/ci-test.md", version: read.structuredContent.result.version,
        });
        assert.equal(result.structuredContent.status, "ok");
        assert.deepEqual(result.structuredContent.effects.filter((effect: any) => effect.kind !== "index_updated").map((effect: any) => [effect.kind, effect.completed]), [
            ["destination_created", true], ["source_deleted", true],
        ]);
        assert.ok(!existsSync(join(vaultDir, "ci-test.md")));
        assert.ok(existsSync(join(vaultDir, "archive/ci-test.md")));
    });
});

describe("E2E: delete_note", () => {
    it("deletes a note", async () => {
        const read = await callToolResult("read_note", { path: "archive/ci-test.md" });
        const result = await callToolResult("delete_note", { path: "archive/ci-test.md", version: read.structuredContent.result.version });
        assert.equal(result.structuredContent.status, "ok");
        assert.ok(!existsSync(join(vaultDir, "archive/ci-test.md")));
    });
});

// --- Restart Test ---

describe("E2E: READ_ONLY mode", () => {
    it("hides write tools and rejects write calls when READ_ONLY=true", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", READ_ONLY: "true" });
        assert.ok(serverLogs.includes("READ_ONLY mode"), "should log READ_ONLY mode at startup");

        const list = await mcpCall("tools/list", {});
        const tools: string[] = (list?.result?.tools ?? []).map((t: any) => t.name);
        for (const w of ["create_note", "edit_note", "delete_note", "move_note"]) {
            assert.ok(!tools.includes(w), `${w} should not be registered in READ_ONLY mode`);
        }
        for (const r of ["read_note", "list_notes", "list_folders", "list_tags", "get_note_metadata"]) {
            assert.ok(tools.includes(r), `${r} should remain available in READ_ONLY mode`);
        }

        const resp = await mcpCall("tools/call", { name: "create_note", arguments: { path: "blocked.md", content: "x" } });
        assert.ok(resp?.error, "create_note call should return an error");
        assert.ok(!existsSync(join(vaultDir, "blocked.md")), "no file should be created when write is blocked");
    });
});

describe("E2E: MCP_INSTRUCTIONS", () => {
    it("appends env-var contents to the instructions string", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", MCP_INSTRUCTIONS: "inline-rule-XYZ" });
        const instr: string = lastInitResult?.result?.instructions ?? "";
        assert.ok(instr.includes("Access and manage Markdown notes"), "base instructions still present");
        assert.ok(instr.includes("inline-rule-XYZ"), "inline env contents appended");
    });

    it("file wins when both MCP_INSTRUCTIONS and MCP_INSTRUCTIONS_FILE are set", async () => {
        await stopServer();
        const instructionsFile = join(vaultDir, "agent-rules.md");
        await writeFile(instructionsFile, "file-rule-ABC\nfile-rule-DEF");
        await startServer({
            VAULT_PATH: vaultDir,
            VAULT_NAME: "TestVault",
            MCP_INSTRUCTIONS: "inline-rule-XYZ",
            MCP_INSTRUCTIONS_FILE: instructionsFile,
        });
        const instr: string = lastInitResult?.result?.instructions ?? "";
        assert.ok(instr.includes("Access and manage Markdown notes"), "base instructions still present");
        assert.ok(instr.includes("file-rule-ABC"), "file contents appended");
        assert.ok(instr.includes("file-rule-DEF"), "file contents appended (multiline)");
        assert.ok(!instr.includes("inline-rule-XYZ"), "inline env ignored when file is set");
        assert.ok(serverLogs.includes("ignoring MCP_INSTRUCTIONS env var"), "should warn about precedence");
    });
});

describe("E2E: cold restart with persisted index", () => {
    it("picks up changes and removes stale entries after restart", async () => {
        // HTTP readiness does not mean the preceding startup has indexed its
        // fixtures (including agent-rules.md). Establish a persisted baseline
        // before testing which changes are discovered across the next restart.
        const baselineDeadline = Date.now() + 5000;
        while (Date.now() < baselineDeadline && !/Search index (updated|up to date)/.test(serverLogs)) {
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.match(serverLogs, /Search index (updated|up to date)/, "Baseline index reconciliation must finish before shutdown");
        // Stop server (closes SQLite and flushes auth state)
        const firstLogs = await stopServer();
        assert.ok(firstLogs.includes("Shutting down..."), "Should shut down cleanly");

        // Modify vault while server is down (simulates Obsidian edits)
        await writeFile(join(vaultDir, "new-while-down.md"), "# Created while MCP was down\nfreshcontent");
        await writeFile(join(vaultDir, "daily/2026-03-24.md"), "# Daily Note\nUpdated while down uniqueword");
        await unlink(join(vaultDir, "projects/test.md")); // delete a note

        // Restart server
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault" });

        // The server accepts connections while index reconciliation runs in the
        // background — wait for the incremental update to finish before asserting.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !serverLogs.includes("Search index updated")) {
            await new Promise((r) => setTimeout(r, 50));
        }
        const restartLogs = serverLogs;

        // Only the two new/changed bodies should be read; the removed path is
        // reconciled from the persisted path set.
        assert.ok(
            restartLogs.includes("Updating search index (2 changed") && restartLogs.includes("1 deleted"),
            `Should incrementally reconcile two changed notes and one deletion\n${restartLogs}`,
        );

        // New note should be listed
        const listNew = await callTool("list_notes", { name: "new-while-down" });
        assert.ok(listNew.includes("new-while-down.md"), "New note should be found");

        // Updated note should be listed
        const list = await callTool("list_notes");
        assert.ok(list.includes("daily/2026-03-24.md"), "Updated note should be found");

        // Deleted note should be gone
        assert.ok(!list.includes("projects/test.md"), "Deleted note should not appear");
    });
});

describe("E2E: stateless Streamable HTTP", () => {
    it("serves consecutive tool calls without a server session ID", async () => {
        await stopServer();
        await startServer({
            VAULT_PATH: vaultDir,
            VAULT_NAME: "TestVault",
            LOG_LEVEL: "debug",
        });

        assert.equal(sessionId, "", "stateless responses should not issue an MCP session ID");
        assert.ok(serverLogs.includes("Streamable HTTP, stateless"), "should log stateless transport mode");

        const first = await callTool("list_notes", { name: "Welcome" });
        const second = await callTool("search_notes", { query: "welcome" });
        assert.ok(first.includes("Welcome.md"));
        assert.ok(second.includes("Welcome.md"));
        await new Promise((r) => setTimeout(r, 1500));
        assert.ok(
            !serverLogs.includes("could not infer client capabilities"),
            "stateless serving should not poll unavailable client capabilities",
        );

        const secretPath = "privacy-do-not-log-this-path.md";
        const secretContent = "privacy-do-not-log-this-content";
        const created = await callToolResult("create_note", { path: secretPath, content: secretContent });
        const secretVersion = created.structuredContent.result.version;
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.ok(serverLogs.includes("[tool] create_note invoked"), "debug logs retain operation-level diagnostics");
        for (const secret of [secretPath, secretContent, secretVersion]) {
            assert.ok(!serverLogs.includes(secret), "logs must not contain note paths, Markdown, or opaque versions");
        }
    });
});

// Runs last: replaces the shared auth server with a no-auth instance to exercise
// the Host-header allowlist. Uses raw http.request because fetch() forbids
// setting the Host header — which is exactly what a DNS-rebinding browser sends.
describe("E2E: no-auth Host allowlist (DNS-rebinding)", () => {
    function initializeWithHost(hostHeader: string, originHeader?: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "initialize",
                params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "poc", version: "1.0" } },
            });
            const headers: Record<string, string | number> = {
                "Host": hostHeader,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Content-Length": Buffer.byteLength(body),
            };
            if (originHeader) headers["Origin"] = originHeader;
            const req = httpRequest(
                { host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers },
                (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
            );
            req.on("error", reject);
            req.end(body);
        });
    }

    before(async () => {
        await stopServer();
        // Empty MCP_AUTH_TOKEN => no-auth mode, which enables the Host allowlist.
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", MCP_AUTH_TOKEN: "" });
    });

    it("rejects a forged (DNS-rebound) Host", async () => {
        assert.equal(await initializeWithHost("attacker.example"), 403);
    });

    it("rejects userinfo/path smuggling in Host", async () => {
        // The Web Request adapter rejects URL credentials before authentication.
        assert.equal(await initializeWithHost("attacker.example@127.0.0.1"), 400);
    });

    it("allows a genuine local Host", async () => {
        assert.equal(await initializeWithHost(`127.0.0.1:${PORT}`), 200);
    });

    it("rejects a cross-origin browser request with a loopback Host (wildcard-CORS bypass)", async () => {
        // The direct fetch('http://127.0.0.1/mcp') attack: real Host, attacker Origin.
        assert.equal(await initializeWithHost(`127.0.0.1:${PORT}`, "http://attacker.example"), 403);
    });

    it("allows a local browser Origin (e.g. MCP Inspector on localhost)", async () => {
        assert.equal(await initializeWithHost(`127.0.0.1:${PORT}`, `http://localhost:${PORT}`), 200);
        assert.equal(await initializeWithHost(`127.0.0.1:${PORT}`, "http://[::1]:4321"), 200);
    });

    it("honors MCP_ALLOWED_HOSTS", async () => {
        await stopServer();
        await startServer({ VAULT_PATH: vaultDir, VAULT_NAME: "TestVault", MCP_AUTH_TOKEN: "", MCP_ALLOWED_HOSTS: "myhost.local" });
        assert.equal(await initializeWithHost("myhost.local"), 200);
        assert.equal(await initializeWithHost("myhost.local", "https://myhost.local:4321"), 200);
        assert.equal(await initializeWithHost("attacker.example"), 403);
    });
});
