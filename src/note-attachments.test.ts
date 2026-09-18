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
