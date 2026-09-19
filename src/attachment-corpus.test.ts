import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";
import { validateAttachment, type AttachmentValidation } from "./attachment-validation.js";
import { DEFAULT_ATTACHMENT_LIMITS } from "./attachments.js";
import {
    PNG_SIGNATURE, idat, ihdr, minimalPdf, onePixelPng, paddedPdf, pngFile, smallJpeg, smallWebp,
    vp8Payload, vp8lPayload, vp8xPayload, webpFile,
} from "../test/media-fixtures.js";

const { maxPixels } = DEFAULT_ATTACHMENT_LIMITS;
type Expected = "ok" | "MALFORMED_CONTENT" | "UNSUPPORTED_CONTENT" | "DIMENSION_LIMIT";

/**
 * Every finding against this validator so far has been a structurally plausible file
 * measured wrongly, not a random byte string — a canvas disagreeing with its frame, a
 * second bitstream chunk, bytes past a terminator. Unit tests kept passing through all
 * of them because they assert the cases somebody already thought of. This table varies
 * one property of an otherwise valid file at a time, so a shape nobody has hit yet is
 * still covered, and a tightening that starts rejecting real files shows up here.
 */
const corpus: [name: string, bytes: Buffer, expected: Expected][] = [
    // --- PNG ---
    ["png: baseline", onePixelPng(), "ok"],
    ["png: trailing bytes after IEND", Buffer.concat([onePixelPng(), Buffer.alloc(4096)]), "ok"],
    ["png: ancillary chunk before IDAT", pngFile([["IHDR", ihdr(1, 1)], ["tEXt", Buffer.from("a\0b")], ["IDAT", idat()], ["IEND", Buffer.alloc(0)]]), "ok"],
    ["png: two IDAT chunks", pngFile([["IHDR", ihdr(1, 1)], ["IDAT", idat()], ["IDAT", idat()], ["IEND", Buffer.alloc(0)]]), "ok"],
    ["png: 16-bit greyscale", pngFile([["IHDR", ihdr(1, 1, 16, 0)], ["IDAT", idat()], ["IEND", Buffer.alloc(0)]]), "ok"],
    ["png: no IEND", pngFile([["IHDR", ihdr(1, 1)], ["IDAT", idat()]]), "MALFORMED_CONTENT"],
    ["png: non-empty IEND", pngFile([["IHDR", ihdr(1, 1)], ["IDAT", idat()], ["IEND", Buffer.from("x")]]), "MALFORMED_CONTENT"],
    ["png: no IDAT", pngFile([["IHDR", ihdr(1, 1)], ["IEND", Buffer.alloc(0)]]), "MALFORMED_CONTENT"],
    ["png: truncated mid-stream", onePixelPng().subarray(0, 30), "MALFORMED_CONTENT"],
    ["png: signature only", Buffer.from(PNG_SIGNATURE), "MALFORMED_CONTENT"],
    ["png: zero width", pngFile([["IHDR", ihdr(0, 1)], ["IDAT", idat()], ["IEND", Buffer.alloc(0)]]), "MALFORMED_CONTENT"],
    ["png: invalid bit depth for colour type", pngFile([["IHDR", ihdr(1, 1, 4, 2)], ["IDAT", idat()], ["IEND", Buffer.alloc(0)]]), "MALFORMED_CONTENT"],
    ["png: APNG animation control", pngFile([["IHDR", ihdr(1, 1)], ["acTL", Buffer.alloc(8)], ["IDAT", idat()], ["IEND", Buffer.alloc(0)]]), "UNSUPPORTED_CONTENT"],
    ["png: over per-side cap", pngFile([["IHDR", ihdr(8001, 1)], ["IDAT", idat()], ["IEND", Buffer.alloc(0)]]), "DIMENSION_LIMIT"],
    ["png: within side cap, over pixel budget", pngFile([["IHDR", ihdr(8000, 7000)], ["IDAT", idat()], ["IEND", Buffer.alloc(0)]]), "DIMENSION_LIMIT"],

    // --- WebP ---
    ["webp: lossless still", webpFile([["VP8L", vp8lPayload(2, 2)]]), "ok"],
    ["webp: lossy still", Buffer.from(smallWebp), "ok"],
    ["webp: VP8X canvas matching frame", webpFile([["VP8X", vp8xPayload(2, 2)], ["VP8L", vp8lPayload(2, 2)]]), "ok"],
    ["webp: VP8X canvas larger than frame", webpFile([["VP8X", vp8xPayload(4, 4)], ["VP8L", vp8lPayload(2, 2)]]), "ok"],
    ["webp: VP8X canvas smaller than frame", webpFile([["VP8X", vp8xPayload(1, 1)], ["VP8L", vp8lPayload(2000, 2000)]]), "MALFORMED_CONTENT"],
    ["webp: two VP8L chunks", webpFile([["VP8L", vp8lPayload(16000, 16000)], ["VP8L", vp8lPayload(2, 2)]]), "MALFORMED_CONTENT"],
    ["webp: VP8 then VP8L", webpFile([["VP8 ", vp8Payload(16000, 16000)], ["VP8L", vp8lPayload(2, 2)]]), "MALFORMED_CONTENT"],
    ["webp: VP8L then VP8", webpFile([["VP8L", vp8lPayload(16000, 16000)], ["VP8 ", vp8Payload(2, 2)]]), "MALFORMED_CONTENT"],
    ["webp: two VP8X chunks", webpFile([["VP8X", vp8xPayload(16000, 16000)], ["VP8X", vp8xPayload(1, 1)], ["VP8L", vp8lPayload(1, 1)]]), "MALFORMED_CONTENT"],
    ["webp: VP8X after the bitstream", webpFile([["VP8L", vp8lPayload(2, 2)], ["VP8X", vp8xPayload(2, 2)]]), "MALFORMED_CONTENT"],
    ["webp: no bitstream chunk", webpFile([["VP8X", vp8xPayload(2, 2)]]), "MALFORMED_CONTENT"],
    ["webp: unparseable bitstream chunk", webpFile([["VP8L", Buffer.alloc(21)]]), "MALFORMED_CONTENT"],
    ["webp: ANIM chunk", webpFile([["VP8X", vp8xPayload(2, 2)], ["ANIM", Buffer.alloc(6)], ["VP8L", vp8lPayload(2, 2)]]), "UNSUPPORTED_CONTENT"],
    ["webp: VP8X animation flag", webpFile([["VP8X", vp8xPayload(2, 2, 0x02)], ["VP8L", vp8lPayload(2, 2)]]), "UNSUPPORTED_CONTENT"],
    ["webp: frame over per-side cap", webpFile([["VP8L", vp8lPayload(8001, 2)]]), "DIMENSION_LIMIT"],

    // --- JPEG ---
    ["jpeg: baseline", Buffer.from(smallJpeg), "ok"],
    ["jpeg: missing EOI", smallJpeg.subarray(0, smallJpeg.length - 2), "MALFORMED_CONTENT"],
    ["jpeg: marker only", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "MALFORMED_CONTENT"],

    // --- PDF ---
    ["pdf: minimal", minimalPdf(), "ok"],
    ["pdf: padded", paddedPdf(64 * 1024), "ok"],
    ["pdf: trailing newline after EOF", Buffer.concat([minimalPdf(), Buffer.from("\n")]), "ok"],
    ["pdf: garbage after EOF", Buffer.concat([minimalPdf(), Buffer.from("junk")]), "MALFORMED_CONTENT"],
    ["pdf: no EOF marker", Buffer.from(minimalPdf().toString().replace("%%EOF", "")), "MALFORMED_CONTENT"],
    ["pdf: startxref past end", Buffer.from(minimalPdf().toString().replace(/startxref\n\d+/, "startxref\n999999")), "MALFORMED_CONTENT"],
    ["pdf: header only", Buffer.from("%PDF-1.4\n"), "MALFORMED_CONTENT"],

    // --- Not a supported type at all ---
    ["other: GIF", Buffer.from("GIF89a" + "\0".repeat(64)), "UNSUPPORTED_CONTENT"],
    ["other: empty", Buffer.alloc(0), "UNSUPPORTED_CONTENT"],
    ["other: random bytes", Buffer.alloc(512, 0x5a), "UNSUPPORTED_CONTENT"],
];

const outcome = (result: AttachmentValidation): string => result.status === "ok" ? "ok" : result.code;

it("classifies every shape in the format corpus", () => {
    const wrong: string[] = [];
    for (const [name, bytes, expected] of corpus) {
        const actual = outcome(validateAttachment(new Uint8Array(bytes), maxPixels));
        if (actual !== expected) wrong.push(`${name}: expected ${expected}, got ${actual}`);
    }
    assert.deepEqual(wrong, [], `\n${wrong.join("\n")}\n`);
});

it("reports the sniffed type independently of any extension", () => {
    for (const [bytes, mimeType] of [
        [onePixelPng(), "image/png"], [smallJpeg, "image/jpeg"],
        [smallWebp, "image/webp"], [minimalPdf(), "application/pdf"],
    ] as const) {
        const result = validateAttachment(new Uint8Array(bytes), maxPixels);
        assert.equal(result.status === "ok" && result.mimeType, mimeType);
    }
});

/**
 * Opt-in sweep over real files, for a vault or a media folder:
 *
 *     ATTACHMENT_CORPUS_DIR=~/Vault pnpm test
 *     ATTACHMENT_CORPUS_DIR=~/Vault ATTACHMENT_CORPUS_BASELINE=corpus.txt pnpm test
 *
 * The table above only covers shapes somebody thought of. This is what caught PNGs
 * rewritten in place without truncating, which every unit test accepted.
 *
 * A rejection rate is the wrong gate — that regression was 2 files in 3,729, well
 * inside any tolerance, and a folder carrying a decoder's own corrupt fixtures sits
 * above one. So the real check is a baseline: record which files are rejected today,
 * and fail when a file that used to validate stops validating. Without a baseline this
 * only reports, plus a loose bound that catches the validator breaking outright.
 */
it("keeps accepting the real media in ATTACHMENT_CORPUS_DIR", { skip: !process.env.ATTACHMENT_CORPUS_DIR }, () => {
    const root = process.env.ATTACHMENT_CORPUS_DIR!;
    const files = globSync("**/*.{png,jpg,jpeg,webp,pdf,PNG,JPG,JPEG,WEBP,PDF}", { cwd: root })
        .map((name) => join(root, name))
        .filter((path) => { try { return statSync(path).isFile(); } catch { return false; } });
    assert.ok(files.length > 0, `no media found under ${root}`);

    const rejected: { path: string; code: string }[] = [];
    let scanned = 0;
    for (const path of files) {
        let bytes: Buffer;
        try { bytes = readFileSync(path); } catch { continue; }
        scanned++;
        const result = validateAttachment(new Uint8Array(bytes), maxPixels);
        if (result.status === "error") rejected.push({ path, code: result.code });
    }
    const rate = rejected.length / scanned;
    console.log(`corpus: scanned=${scanned} rejected=${rejected.length} (${(rate * 100).toFixed(2)}%)`);
    for (const { path, code } of rejected.slice(0, 40)) console.log(`   ${code}  ${path}`);

    const baselinePath = process.env.ATTACHMENT_CORPUS_BASELINE;
    if (baselinePath && existsSync(baselinePath)) {
        const known = new Set(readFileSync(baselinePath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean));
        const novel = rejected.filter(({ path }) => !known.has(path)).map(({ path, code }) => `${code}  ${path}`);
        assert.deepEqual(novel, [], `\nfiles that validated when the baseline was recorded are now rejected:\n${novel.join("\n")}\n`);
        const recovered = [...known].filter((path) => !rejected.some((entry) => entry.path === path));
        if (recovered.length) console.log(`   ${recovered.length} baseline entries now validate; re-record to tighten the gate`);
    } else {
        console.log(baselinePath
            ? `   no baseline at ${baselinePath}; write the paths above to it to gate on new rejections`
            : "   set ATTACHMENT_CORPUS_BASELINE=<file> to gate on new rejections");
        assert.ok(rate < 0.05, `rejected ${(rate * 100).toFixed(2)}% of real media, which means the validator is broken, not drifting`);
    }
});
