import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ViteMCP } from "@vitemcp/server";
import { LocalVault } from "./vault-local.js";
import { DEFAULT_ATTACHMENT_LIMITS, attachmentResultSchema, registerAttachmentTools, resolveAttachmentPath, readValidatedAttachment } from "./attachments.js";
import { validateAttachment } from "./attachment-validation.js";
import { minimalPdf, onePixelPng, paddedPdf, pngWithDimensions, smallJpeg, smallWebp, webpWithOversizedFrame, webpWithTwoFrames } from "../test/media-fixtures.js";

it("accepts a PNG carrying trailing bytes after IEND but still rejects a corrupt stream", () => {
    const { maxPixels } = DEFAULT_ATTACHMENT_LIMITS;
    // An in-place rewrite that does not truncate leaves real, decodable images with
    // trailing data; requiring IEND at exact EOF rejected them outright.
    const padded = Buffer.concat([onePixelPng(), Buffer.alloc(17050)]);
    assert.deepEqual(validateAttachment(new Uint8Array(padded), maxPixels), { status: "ok", mimeType: "image/png", width: 1, height: 1 });
    const corrupt = onePixelPng();
    corrupt[corrupt.length - 1] ^= 1;
    const result = validateAttachment(new Uint8Array(corrupt), maxPixels);
    assert.equal(result.status === "error" && result.code, "MALFORMED_CONTENT");
    const truncated = onePixelPng().subarray(0, 20);
    const cut = validateAttachment(new Uint8Array(truncated), maxPixels);
    assert.equal(cut.status === "error" && cut.code, "MALFORMED_CONTENT");
});

it("rejects a still WebP carrying more than one bitstream chunk", () => {
    // Only the last VP8/VP8L was measured, so an oversized frame could hide behind a
    // small trailing one and skip the dimension and pixel budgets entirely.
    const result = validateAttachment(new Uint8Array(webpWithTwoFrames()), DEFAULT_ATTACHMENT_LIMITS.maxPixels);
    assert.equal(result.status === "error" && result.code, "MALFORMED_CONTENT");
    assert.equal(validateAttachment(new Uint8Array(smallWebp), DEFAULT_ATTACHMENT_LIMITS.maxPixels).status, "ok");
});

it("bounds the read by the largest limit so the extension cannot pre-empt the sniffed type", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-limit-"));
    try {
        // Between the image and PDF limits: the extension must not decide the outcome.
        const pdf = paddedPdf(8 * 1024 * 1024);
        assert.ok(pdf.length > DEFAULT_ATTACHMENT_LIMITS.imageMaxBytes && pdf.length < DEFAULT_ATTACHMENT_LIMITS.pdfMaxBytes);
        await writeFile(join(root, "document.pdf"), pdf);
        await writeFile(join(root, "document.png"), pdf);
        const vault = new LocalVault(root);
        for (const name of ["document.pdf", "document.png"]) {
            const read = await readValidatedAttachment(vault, name, DEFAULT_ATTACHMENT_LIMITS);
            assert.equal(read.status, "ok", `${name}: ${read.status === "error" ? read.error.code : ""}`);
            if (read.status === "ok") assert.equal(read.value.mimeType, "application/pdf");
        }
        // An image beyond the image limit is still refused, whatever it is called.
        await writeFile(join(root, "huge.png"), Buffer.concat([onePixelPng(), Buffer.alloc(8 * 1024 * 1024)]));
        const oversized = await readValidatedAttachment(vault, "huge.png", DEFAULT_ATTACHMENT_LIMITS);
        assert.equal(oversized.status, "error");
        if (oversized.status === "error") assert.equal(oversized.error.code, "TOO_LARGE");
    } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects an image wider or taller than the client accepts", () => {
    const { maxPixels } = DEFAULT_ATTACHMENT_LIMITS;
    for (const [width, height] of [[8001, 10], [10, 8001]] as const) {
        const result = validateAttachment(new Uint8Array(pngWithDimensions(width, height)), maxPixels);
        assert.equal(result.status === "error" && result.code, "DIMENSION_LIMIT", `${width}x${height}`);
    }
    // At the per-side limit and inside the pixel budget, the image is still served.
    assert.equal(validateAttachment(new Uint8Array(pngWithDimensions(8000, 4000)), maxPixels).status, "ok");
});

it("keeps the default byte limits under the client's base64 ceilings", () => {
    const base64Bytes = (raw: number) => 4 * Math.ceil(raw / 3);
    // The Claude API rejects an image over 10 MB base64 outright, and a PDF shares the
    // 32 MB request budget with the conversation, so raw defaults must leave room.
    assert.ok(base64Bytes(DEFAULT_ATTACHMENT_LIMITS.imageMaxBytes) < 10_000_000);
    assert.ok(base64Bytes(DEFAULT_ATTACHMENT_LIMITS.pdfMaxBytes) < 32_000_000 / 2);
});

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

it("resolves a concrete target without enumerating the vault, and still falls back when it must", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-fastpath-"));
    try {
        await mkdir(join(root, "notes"));
        await mkdir(join(root, "assets"));
        await writeFile(join(root, "notes", "source.md"), "![[diagram.png]]");
        await writeFile(join(root, "assets", "diagram.png"), onePixelPng());
        const real = new LocalVault(root);
        let enumerations = 0;
        const vault: any = {
            readVersioned: (path: string) => real.readVersioned(path),
            attachmentExists: (path: string) => real.attachmentExists(path),
            listAttachments: async () => { enumerations++; return real.listAttachments(); },
        };
        const source = { sourceNotePath: "notes/source.md" };

        assert.deepEqual(await resolveAttachmentPath(vault, { target: "../assets/diagram.png", ...source }),
            { status: "ok", path: "assets/diagram.png" });
        assert.equal(enumerations, 0, "a concrete candidate must not scan the vault");
        assert.deepEqual(await resolveAttachmentPath(vault, { target: "/assets/diagram.png", ...source }),
            { status: "ok", path: "assets/diagram.png" });
        assert.equal(enumerations, 0);

        // A bare name genuinely needs the listing, and so does a differently-cased path.
        assert.deepEqual(await resolveAttachmentPath(vault, { target: "diagram.png", ...source }),
            { status: "ok", path: "assets/diagram.png" });
        assert.equal(enumerations, 1);
        assert.deepEqual(await resolveAttachmentPath(vault, { target: "../ASSETS/Diagram.PNG", ...source }),
            { status: "ok", path: "assets/diagram.png" });
        assert.equal(enumerations, 2, "a case-variant path must still fall back to the listing");

        const missing = await resolveAttachmentPath(vault, { target: "../assets/absent.png", ...source });
        assert.equal(missing.status, "error");
        if (missing.status === "error") assert.equal(missing.error.code, "NOT_FOUND");
    } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps a percent-encoded hash in an embed target, and ignores directories named like attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-target-"));
    try {
        await mkdir(join(root, "assets"));
        await mkdir(join(root, "logo.png"));                       // a DIRECTORY, not a file
        await writeFile(join(root, "assets", "logo.png"), onePixelPng());
        await writeFile(join(root, "assets", "report#draft.png"), onePixelPng());
        await writeFile(join(root, "source.md"), "![[logo.png]]");
        const vault = new LocalVault(root);

        // A directory used to enter the listing and shadow the real file as AMBIGUOUS.
        assert.deepEqual(await vault.listAttachments(), ["assets/logo.png", "assets/report#draft.png"]);
        assert.deepEqual(await resolveAttachmentPath(vault, { target: "logo.png", sourceNotePath: "source.md" }),
            { status: "ok", path: "assets/logo.png" });

        // Decoding before splitting truncated the name at "%23" and failed as INVALID_PATH.
        assert.deepEqual(await resolveAttachmentPath(vault, { target: "![x](assets/report%23draft.png)", sourceNotePath: "source.md" }),
            { status: "ok", path: "assets/report#draft.png" });
        // A real fragment on an embed target is still stripped.
        assert.deepEqual(await resolveAttachmentPath(vault, { target: "![[assets/logo.png#page=2]]", sourceNotePath: "source.md" }),
            { status: "ok", path: "assets/logo.png" });
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
        // A VP8X canvas must not understate the frame and slip past the pixel budget.
        await writeFile(join(root, "lying-canvas.webp"), webpWithOversizedFrame());
        const lyingCanvas = await readValidatedAttachment(vault, "lying-canvas.webp", DEFAULT_ATTACHMENT_LIMITS);
        assert.equal(lyingCanvas.status, "error");
        if (lyingCanvas.status === "error") assert.equal(lyingCanvas.error.code, "MALFORMED_CONTENT");
        await writeFile(join(root, "unsupported.png"), Buffer.from("GIF89a"));
        const unsupported = await readValidatedAttachment(vault, "unsupported.png", DEFAULT_ATTACHMENT_LIMITS);
        assert.equal(unsupported.status, "error");
        if (unsupported.status === "error") assert.equal(unsupported.error.code, "UNSUPPORTED_CONTENT");
    } finally { await rm(root, { recursive: true, force: true }); }
});
