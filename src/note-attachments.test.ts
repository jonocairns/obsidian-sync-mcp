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
