import { it } from "node:test";
import assert from "node:assert/strict";
import { structuredSearchResultSchema, searchSchemaVersion, searchError, toSearchToolResult } from "./search-contract.js";

it("validates empty results, errors, count equality, and strict fields", () => {
    const empty = { schemaVersion: searchSchemaVersion, status: "ok" as const,
        result: { hits: [], returnedCount: 0 }, notices: [] };
    assert.equal(toSearchToolResult(empty).isError, false);
    assert.match(toSearchToolResult(empty).content[0].text, /No notes found/);
    assert.equal(structuredSearchResultSchema.safeParse({ ...empty, result: { hits: [], returnedCount: 1 } }).success, false);
    assert.equal(structuredSearchResultSchema.safeParse({ ...empty, hasMore: false }).success, false);
    assert.equal(structuredSearchResultSchema.safeParse({ ...empty, schemaVersion: "2" }).success, false);
    for (const code of ["INVALID_SEARCH_INPUT", "SEARCH_FAILED"] as const) {
        assert.equal(toSearchToolResult(searchError(code)).isError, true);
    }
});

it("renders the validated hit while keeping paths and links separate", () => {
    const hit = { path: "folder/note.md", rank: 0.25, matchedBy: "passage" as const,
        snippet: "Some **text** …", modified: null, deepLink: "obsidian://open?file=folder%2Fnote",
        title: "note", aliases: [], tags: [] };
    const value = { schemaVersion: searchSchemaVersion, status: "ok" as const,
        result: { hits: [hit], returnedCount: 1 }, notices: ["Index is building."] };
    const result = toSearchToolResult(value);
    assert.match(result.content[0].text, /Index is building/);
    assert.match(result.content[0].text, /Some \*\*text\*\* …/);
    assert.equal(result.structuredContent.status, "ok");
    assert.equal(structuredSearchResultSchema.safeParse({ ...value, result: { hits: [{ ...hit, version: "unsafe" }], returnedCount: 1 } }).success, false);
    assert.equal(structuredSearchResultSchema.safeParse({ ...value, result: { hits: [{ ...hit, rank: Infinity }], returnedCount: 1 } }).success, false);
});
