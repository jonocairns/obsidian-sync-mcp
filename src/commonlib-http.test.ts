import assert from "node:assert/strict";
import { test } from "node:test";
import { couchdbDocumentUrl } from "./commonlib-http.js";

for (const [base, expected] of [
    ["http://localhost:5984", "http://localhost:5984/vault/note.md"],
    ["http://admin:test@localhost:5984", "http://localhost:5984/vault/note.md"],
    ["https://user:p%40ss@host/couchdb/", "https://host/couchdb/vault/note.md"],
    ["https://host/proxy%20prefix/couchdb///", "https://host/proxy%20prefix/couchdb/vault/note.md"],
]) {
    test(`CouchDB document URL: ${base}`, () => {
        const actual = couchdbDocumentUrl(base, "vault", "note.md");
        assert.equal(actual, expected);
        assert.doesNotThrow(() => new Request(actual));
    });
}

test("CouchDB database and document IDs remain individual URL segments", () => {
    assert.equal(
        couchdbDocumentUrl("https://host/couchdb/", "vault/name", "Folder/note #1.md"),
        "https://host/couchdb/vault%2Fname/Folder%2Fnote%20%231.md",
    );
});
