import { it } from "node:test";
import assert from "node:assert/strict";
import { frontmatterBoundary } from "./frontmatter.js";
import { applyNoteEdit } from "./note-edit.js";
import { parseFrontmatterAndLinks } from "./parse.js";
import { chunkMarkdown } from "./markdown-chunker.js";
import { extractNoteAttachments } from "./note-attachments.js";

it("shares exact frontmatter boundaries across reads, chunks, attachments and edits", () => {
    for (const newline of ["\n", "\r\n"]) {
        for (const bom of ["", "\uFEFF"]) {
            const prefix = bom + ["---", "aliases: [Alias]", 'example: "![[hidden.png]]"', "---", ""].join(newline);
            const body = ["# Title", "", "Body ![[real.png]]"].join(newline);
            const source = prefix + body;
            assert.equal(frontmatterBoundary(source)?.bodyStart, prefix.length);
            assert.deepEqual(parseFrontmatterAndLinks(source).aliases, ["Alias"]);
            assert.deepEqual(extractNoteAttachments(source).map((a) => a.target), ["real.png"]);
            assert.deepEqual(chunkMarkdown(source), [{ ordinal: 0, heading: "Title", breadcrumb: "Title", body: "Body ![[real.png]]" }]);
            assert.deepEqual(applyNoteEdit(source, "prepend_body", "INSERT"), {
                ok: true, content: prefix + "INSERT" + body, replacements: 0,
            });
        }
    }
});

it("requires a whole closing delimiter and handles empty, EOF and invalid YAML blocks", () => {
    assert.equal(frontmatterBoundary("---\nx: y\n---not-a-delimiter\nbody"), null);
    assert.equal(frontmatterBoundary("text\n---\nx: y\n---\n"), null);
    assert.equal(frontmatterBoundary("---\n---\nbody")?.bodyStart, 8);
    const eof = "---\naliases: [Alias]\n---";
    assert.equal(frontmatterBoundary(eof)?.bodyStart, eof.length);
    assert.deepEqual(parseFrontmatterAndLinks(eof).aliases, ["Alias"]);
    // Exact editing still relies on the caller to supply any required separator.
    assert.deepEqual(applyNoteEdit(eof, "prepend_body", "\nbody"), { ok: true, content: eof + "\nbody", replacements: 0 });
    const invalid = "---\ninvalid: [\n---\nbody";
    assert.deepEqual(parseFrontmatterAndLinks(invalid).frontmatter, {});
    assert.deepEqual(applyNoteEdit(invalid, "prepend_body", "top"), { ok: true, content: invalid.replace("body", "topbody"), replacements: 0 });
});
