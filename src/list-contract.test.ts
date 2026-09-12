import { it } from "node:test";
import assert from "node:assert/strict";
import { structuredListResultSchema, toListToolResult, listError } from "./list-contract.js";

const success = { schemaVersion: "1.0.0", status: "ok", notices: [], result: {
    kind: "notes", source: "index", entries: [{ path: "a.md", modified: null, deepLink: "obsidian://open?a" }],
    returnedCount: 1, total: 2, truncated: true,
} } as const;
it("validates populated, empty, truncated and error listings with strict fields and count invariants", () => {
    assert.ok(structuredListResultSchema.safeParse(success).success);
    for (const result of [
        { ...success.result, returnedCount: 0 }, { ...success.result, total: 0 },
        { ...success.result, truncated: false }, { ...success.result, secret: "private" },
        { ...success.result, entries: [{ ...success.result.entries[0], version: "forbidden" }] },
        { ...success.result, entries: Array(1001).fill(success.result.entries[0]), returnedCount: 1001, total: 1001, truncated: false },
    ]) assert.equal(structuredListResultSchema.safeParse({ ...success, result }).success, false);
    for (const result of [
        { ...success.result, total: 1, truncated: false },
        { ...success.result, entries: [], returnedCount: 0, total: 0, truncated: false },
        { kind: "folders", source: "vault", entries: [{ path: "", directNoteCount: 1 }] },
        { kind: "tags", source: "index", entries: [] },
    ]) assert.ok(structuredListResultSchema.safeParse({ ...success, result }).success);
    for (const code of ["INVALID_LIST_INPUT", "LIST_FAILED"] as const) {
        assert.ok(structuredListResultSchema.safeParse(listError(code)).success);
        assert.equal(structuredListResultSchema.safeParse({ ...listError(code), notices: [] }).success, false);
    }
    const output = toListToolResult(structuredListResultSchema.parse(success));
    assert.equal(output.structuredContent.status, "ok");
    assert.match(output.content[0].text, /\[a.md\]\(obsidian:\/\/open\?a\)/);
    assert.match(output.content[0].text, /1 more/);
});
