import { it } from "node:test";
import assert from "node:assert/strict";
import { extractNoteAttachments } from "./note-attachments.js";

it("finds supported vault attachments in order without loading them", () => {
    const markdown = [
        "Screenshot ![[assets/overview.png|640]] and [[reports/brief.pdf#page=3|Brief]]",
        "![UI](../assets/ui%20state.webp) [scan](<../assets/scan.pdf>)",
        "![chart](../assets/chart(v2).png) \\[[escaped.png]]",
        "[external](https://example.com/report.pdf) and [[another note]]",
        "`![[code.png]]`",
        "```md",
        "![[fenced.png]]",
        "```still in code",
        "![[still-fenced.png]]",
        "```",
        "Screenshot ![[assets/overview.png|640]]",
    ].join("\n");
    assert.deepEqual(extractNoteAttachments(markdown), [
        { target: "assets/overview.png", kind: "embed", syntax: "wikilink", mimeTypeHint: "image/png", display: "640" },
        { target: "reports/brief.pdf", kind: "link", syntax: "wikilink", mimeTypeHint: "application/pdf", fragment: "page=3", display: "Brief" },
        { target: "../assets/ui state.webp", kind: "embed", syntax: "markdown", mimeTypeHint: "image/webp", display: "UI" },
        { target: "../assets/scan.pdf", kind: "link", syntax: "markdown", mimeTypeHint: "application/pdf", display: "scan" },
        { target: "../assets/chart(v2).png", kind: "embed", syntax: "markdown", mimeTypeHint: "image/png", display: "chart" },
    ]);
});

it("keeps the actual MIME type provisional until read_attachment checks the bytes", () => {
    assert.deepEqual(extractNoteAttachments("![[image.JPG]] ![[archive.zip]]"), [
        { target: "image.JPG", kind: "embed", syntax: "wikilink", mimeTypeHint: "image/jpeg" },
    ]);
});

it("reads a parenthesised link title without losing names that end in brackets", () => {
    assert.deepEqual(extractNoteAttachments("[scan](scan.pdf (PDF scan))").map((found) => found.target), ["scan.pdf"]);
    assert.deepEqual(extractNoteAttachments("![x](report (1).png)").map((found) => found.target), ["report (1).png"]);
    assert.deepEqual(extractNoteAttachments("![x](report (1).png (title))").map((found) => found.target), ["report (1).png"]);
});

it("reads an unmatched backtick as literal text, not an open code span", () => {
    const targets = (markdown: string) => extractNoteAttachments(markdown).map((found) => found.target);
    // A stray backtick used to latch the scanner into code mode for the rest of the note,
    // so every later embed vanished while outgoingLinks still reported it.
    assert.deepEqual(targets("Press the ` key.\n\n![[diagram.png]]"), ["diagram.png"]);
    assert.deepEqual(targets("a ` b ![[image.png]]"), ["image.png"]);
    assert.deepEqual(targets("Use ``code` now.\n\n![[a.png]]"), ["a.png"]);
    assert.deepEqual(targets("# Heading with a ` tick\n\n![[after.png]]"), ["after.png"]);
    // A run that does close still hides its contents, including a fence marker inside it.
    assert.deepEqual(targets("`![[hidden.png]]` ![[real.png]]"), ["real.png"]);
    assert.deepEqual(targets("``![[a.png]]`` ![[b.png]]"), ["b.png"]);
});

it("scans a long malformed line in linear time", () => {
    const scale = (length: number) => {
        const started = performance.now();
        assert.deepEqual(extractNoteAttachments(`${"[".repeat(length)}\n![[real.png]]`), [
            { target: "real.png", kind: "embed", syntax: "wikilink", mimeTypeHint: "image/png" },
        ]);
        return performance.now() - started;
    };
    scale(2_000);
    const small = Math.max(scale(20_000), 1);
    // Quadratic rescanning made a tenfold line cost a hundredfold; linear stays well under that.
    assert.ok(scale(200_000) < small * 30, "attachment scanning is superlinear in line length");
});

it("keeps a percent-encoded hash in the filename instead of reading it as a fragment", () => {
    // Decoding before splitting turned "%23" into a fragment separator and dropped the reference.
    assert.deepEqual(extractNoteAttachments("![x](report%23draft.png)"), [
        { target: "report#draft.png", kind: "embed", syntax: "markdown", mimeTypeHint: "image/png", display: "x" },
    ]);
    // A real fragment still splits, and is decoded on its own.
    assert.deepEqual(extractNoteAttachments("![x](a.png#page%3D2)"), [
        { target: "a.png", kind: "embed", syntax: "markdown", mimeTypeHint: "image/png", fragment: "page=2", display: "x" },
    ]);
    assert.deepEqual(extractNoteAttachments("![x](../assets/ui%20state.webp)").map((f) => f.target), ["../assets/ui state.webp"]);
});

it("reads a quoted Markdown title without losing names that contain quotes or brackets", () => {
    const targets = (markdown: string) => extractNoteAttachments(markdown).map((found) => found.target);
    // A parenthesis inside a quoted title is text; treating it as structure dropped the link.
    assert.deepEqual(targets('[scan](scan.pdf "title (")'), ["scan.pdf"]);
    assert.deepEqual(targets("[scan](scan.pdf 'title (')"), ["scan.pdf"]);
    // A title opens only after whitespace, so an apostrophe inside a name is still a name.
    assert.deepEqual(targets("![x](jono's file.png)"), ["jono's file.png"]);
    assert.deepEqual(targets("![x](a(b)c.png)"), ["a(b)c.png"]);
    assert.deepEqual(targets("![x](report (1).png)"), ["report (1).png"]);
});
