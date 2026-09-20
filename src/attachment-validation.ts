export type AttachmentMime = "image/png" | "image/jpeg" | "image/webp" | "application/pdf";
export type AttachmentValidation =
    | { status: "ok"; mimeType: AttachmentMime }
    | { status: "error"; code: "UNSUPPORTED_CONTENT" | "MALFORMED_CONTENT" };

/**
 * Establishes what a file *is* from its bytes, and that the container is intact. It
 * deliberately does not measure the image or reject animation.
 *
 * Deriving dimensions meant parsing each format's variants — a VP8X canvas against a
 * VP8/VP8L frame, across chunk orderings — and four review rounds found four separate
 * ways to measure the wrong one, each letting an oversized image through while
 * reporting a small size. The budget it fed was never load-bearing: the byte limit
 * already bounds what is read and sent, nothing here ever decodes an image, and a file
 * too large or too animated for the client is refused by the client, which is the
 * component that actually knows its own limits. Removing the measurement removes the
 * bug class outright; the cost is one wasted round trip on an image the API rejects.
 */

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ascii = (bytes: Uint8Array, start: number, length: number) => Buffer.from(bytes.subarray(start, start + length)).toString("latin1");
const be32 = (bytes: Uint8Array, at: number) => (bytes[at] * 2 ** 24 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
const le32 = (bytes: Uint8Array, at: number) => (bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536 + bytes[at + 3] * 16777216) >>> 0;
function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

const malformed = { status: "error", code: "MALFORMED_CONTENT" } as const;

function png(bytes: Uint8Array): AttachmentValidation {
    if (bytes.length < 45 || be32(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") return malformed;
    const colourDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!colourDepths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return malformed;
    let offset = 8;
    let sawIdat = false;
    let sawIend = false;
    while (offset + 12 <= bytes.length) {
        const length = be32(bytes, offset);
        if (length > bytes.length - offset - 12) return malformed;
        const kind = ascii(bytes, offset + 4, 4);
        if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== be32(bytes, offset + 8 + length)) return malformed;
        if (kind === "IDAT") sawIdat = true;
        // Trailing bytes after IEND are accepted. An in-place rewrite that did not
        // truncate leaves them behind, every decoder stops at IEND, and the chunk
        // CRCs above already proved the stream.
        if (kind === "IEND") { sawIend = length === 0; break; }
        offset += length + 12;
    }
    return sawIdat && sawIend ? { status: "ok", mimeType: "image/png" } : malformed;
}

function jpeg(bytes: Uint8Array): AttachmentValidation {
    // SOI plus a terminating EOI. Walking the segments only ever served to reach a
    // frame header for its dimensions, which is no longer read.
    return bytes.length >= 6 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
        ? { status: "ok", mimeType: "image/jpeg" } : malformed;
}

function webp(bytes: Uint8Array): AttachmentValidation {
    if (bytes.length < 20 || ascii(bytes, 8, 4) !== "WEBP" || le32(bytes, 4) + 8 !== bytes.length) return malformed;
    // Walk the container only far enough to prove the chunks tile it exactly. The
    // chunk *contents* are the decoder's business.
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const length = le32(bytes, offset + 4);
        if (offset + 8 + length > bytes.length) return malformed;
        offset += 8 + length + (length & 1);
    }
    return offset === bytes.length ? { status: "ok", mimeType: "image/webp" } : malformed;
}

function pdf(bytes: Uint8Array): AttachmentValidation {
    if (bytes.length < 30 || !/^%PDF-[12]\.[0-9]/.test(ascii(bytes, 0, 8))) return malformed;
    const tail = ascii(bytes, Math.max(0, bytes.length - 2048), Math.min(2048, bytes.length));
    const eof = tail.lastIndexOf("%%EOF");
    const xref = tail.lastIndexOf("startxref", eof);
    if (eof < 0 || xref < 0 || tail.slice(eof + 5).trim().length > 0) return malformed;
    const offsetMatch = /^startxref\s+(\d+)\s*$/.exec(tail.slice(xref, eof).trim());
    if (!offsetMatch) return malformed;
    const offset = Number(offsetMatch[1]);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) return malformed;
    const start = ascii(bytes, offset, Math.min(40, bytes.length - offset));
    if (!start.startsWith("xref") && !/^\d+\s+\d+\s+obj\b/.test(start)) return malformed;
    return { status: "ok", mimeType: "application/pdf" };
}

export function validateAttachment(bytes: Uint8Array): AttachmentValidation {
    if (bytes.length >= 8 && PNG_SIGNATURE.every((value, i) => bytes[i] === value)) return png(bytes);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webp(bytes);
    if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") return pdf(bytes);
    return { status: "error", code: "UNSUPPORTED_CONTENT" };
}
