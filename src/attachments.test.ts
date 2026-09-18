import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ViteMCP } from "@vitemcp/server";
import { LocalVault } from "./vault-local.js";
import { DEFAULT_ATTACHMENT_LIMITS, attachmentResultSchema, registerAttachmentTools, resolveAttachmentPath, readValidatedAttachment } from "./attachments.js";
import { minimalPdf, onePixelPng, smallJpeg, smallWebp } from "../test/media-fixtures.js";

it("reads an image embed and a PDF through tool and resource content without changing bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-read-"));
    try {
        await mkdir(join(root, "notes"));
        await mkdir(join(root, "assets"));
        const image = onePixelPng();
        const pdf = minimalPdf();
        await writeFile(join(root, "notes", "source.md"), "![[photo.png]]\n![[report.pdf]]");
        await writeFile(join(root, "assets", "photo.png"), image);
        await writeFile(join(root, "assets", "report.pdf"), pdf);
        const vault = new LocalVault(root);
        const tools = new Map<string, any>();
        let resource: any;
        registerAttachmentTools({
            addTool: (tool: any) => { tools.set(tool.name, tool); },
            addResourceTemplate: (template: any) => { resource = template; },
        } as unknown as ViteMCP, vault, DEFAULT_ATTACHMENT_LIMITS);
        const call = (input: Record<string, string>) => tools.get("read_attachment").execute(input);

        const imageResult = await call({ target: "![[photo.png]]", sourceNotePath: "notes/source.md" });
        assert.equal(imageResult.structuredContent.status, "ok", JSON.stringify(imageResult.structuredContent));
        assert.equal(attachmentResultSchema.safeParse(imageResult.structuredContent).success, true);
        assert.equal(imageResult.structuredContent.result.mimeType, "image/png");
        assert.deepEqual([imageResult.structuredContent.result.width, imageResult.structuredContent.result.height], [1, 1]);
        assert.equal(imageResult.content[1].type, "image");
        assert.deepEqual(Buffer.from(imageResult.content[1].data, "base64"), image);
        const [id, version] = imageResult.structuredContent.result.uri.replace("obsidian-attachment://vault/", "").split("/");
        const imageResource = await resource.load({ id, version });
        assert.deepEqual(Buffer.from(imageResource.blob, "base64"), image);

        await writeFile(join(root, "assets", "photo.png"), onePixelPng([0, 255, 0]));
        await assert.rejects(resource.load({ id, version }), /version changed/);
        await writeFile(join(root, "assets", "photo.png"), image);

        const pdfResult = await call({ path: "assets/report.pdf" });
        assert.equal(attachmentResultSchema.safeParse(pdfResult.structuredContent).success, true);
        assert.equal(pdfResult.structuredContent.result.mimeType, "application/pdf");
        assert.equal(pdfResult.content[1].type, "resource");
        assert.deepEqual(Buffer.from(pdfResult.content[1].resource.blob, "base64"), pdf);
        assert.equal(pdfResult.structuredContent.result.size, pdf.length);
        const pdfEmbed = await call({ target: "![[report.pdf#page=2]]", sourceNotePath: "notes/source.md" });
        assert.equal(pdfEmbed.structuredContent.result.path, "assets/report.pdf");
        await writeFile(join(root, "assets", "spoof.png"), pdf);
        const spoofed = await call({ path: "assets/spoof.png" });
        assert.equal(spoofed.structuredContent.result.mimeType, "application/pdf");
        for (const [name, bytes, mimeType] of [
            ["small.jpg", smallJpeg, "image/jpeg"],
            ["small.webp", smallWebp, "image/webp"],
        ] as const) {
            await writeFile(join(root, "assets", name), bytes);
            const result = await call({ path: `assets/${name}` });
            assert.equal(result.structuredContent.result.mimeType, mimeType);
            assert.deepEqual([result.structuredContent.result.width, result.structuredContent.result.height], [2, 2]);
            assert.deepEqual(Buffer.from(result.content[1].data, "base64"), bytes);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects ambiguous, missing, traversal, oversized, and malformed attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-reject-"));
    try {
        await mkdir(join(root, "one"));
        await mkdir(join(root, "two"));
        await writeFile(join(root, "source.md"), "![[same.png]]");
        await writeFile(join(root, "one", "same.png"), onePixelPng());
        await writeFile(join(root, "two", "same.png"), onePixelPng());
        await writeFile(join(root, "bad.pdf"), "%PDF-1.4\nnot a complete PDF");
        const vault = new LocalVault(root);
        const ambiguous = await resolveAttachmentPath(vault, { target: "same.png", sourceNotePath: "source.md" });
        assert.equal(ambiguous.status, "error");
        if (ambiguous.status === "error") assert.deepEqual(ambiguous.error.candidates, ["one/same.png", "two/same.png"]);
        await writeFile(join(root, "one", "source.md"), "![image](../two/same.png)");
        assert.deepEqual(await resolveAttachmentPath(vault, { target: "../two/same.png", sourceNotePath: "one/source.md" }),
            { status: "ok", path: "two/same.png" });
        assert.deepEqual(await resolveAttachmentPath(vault, { target: "/two/same.png", sourceNotePath: "one/source.md" }),
            { status: "ok", path: "two/same.png" });
        const traversal = await resolveAttachmentPath(vault, { path: "../secret.png" });
        assert.equal(traversal.status, "error");
        if (traversal.status === "error") assert.equal(traversal.error.code, "INVALID_PATH");
        const missing = await readValidatedAttachment(vault, "missing.png", DEFAULT_ATTACHMENT_LIMITS);
        assert.equal(missing.status, "error");
        if (missing.status === "error") assert.equal(missing.error.code, "NOT_FOUND");
        const oversized = await readValidatedAttachment(vault, "one/same.png", { ...DEFAULT_ATTACHMENT_LIMITS, imageMaxBytes: 10 });
        assert.equal(oversized.status, "error");
        if (oversized.status === "error") assert.equal(oversized.error.code, "TOO_LARGE");
        const malformed = await readValidatedAttachment(vault, "bad.pdf", DEFAULT_ATTACHMENT_LIMITS);
        assert.equal(malformed.status, "error");
        if (malformed.status === "error") assert.equal(malformed.error.code, "MALFORMED_CONTENT");
        const dimensions = await readValidatedAttachment(vault, "one/same.png", { ...DEFAULT_ATTACHMENT_LIMITS, maxPixels: 0 });
        assert.equal(dimensions.status, "error");
        if (dimensions.status === "error") assert.equal(dimensions.error.code, "DIMENSION_LIMIT");
        const corruptPng = onePixelPng();
        corruptPng[corruptPng.length - 1] ^= 1;
        await writeFile(join(root, "corrupt.png"), corruptPng);
        const corrupt = await readValidatedAttachment(vault, "corrupt.png", DEFAULT_ATTACHMENT_LIMITS);
        assert.equal(corrupt.status, "error");
        if (corrupt.status === "error") assert.equal(corrupt.error.code, "MALFORMED_CONTENT");
        await writeFile(join(root, "unsupported.png"), Buffer.from("GIF89a"));
        const unsupported = await readValidatedAttachment(vault, "unsupported.png", DEFAULT_ATTACHMENT_LIMITS);
        assert.equal(unsupported.status, "error");
        if (unsupported.status === "error") assert.equal(unsupported.error.code, "UNSUPPORTED_CONTENT");
    } finally { await rm(root, { recursive: true, force: true }); }
});
