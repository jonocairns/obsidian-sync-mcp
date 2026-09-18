export type AttachmentMime = "image/png" | "image/jpeg" | "image/webp" | "application/pdf";
export type AttachmentValidation =
    | { status: "ok"; mimeType: AttachmentMime; width?: number; height?: number }
    | { status: "error"; code: "UNSUPPORTED_CONTENT" | "MALFORMED_CONTENT" | "DIMENSION_LIMIT" };

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ascii = (bytes: Uint8Array, start: number, length: number) => Buffer.from(bytes.subarray(start, start + length)).toString("latin1");
const be32 = (bytes: Uint8Array, at: number) => (bytes[at] * 2 ** 24 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
const le24 = (bytes: Uint8Array, at: number) => bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16);
const le32 = (bytes: Uint8Array, at: number) => (bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536 + bytes[at + 3] * 16777216) >>> 0;
function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function checkDimensions(width: number, height: number, maxPixels: number): AttachmentValidation {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        return { status: "error", code: "MALFORMED_CONTENT" };
    }
    if (width > 16384 || height > 16384 || width * height > maxPixels) {
        return { status: "error", code: "DIMENSION_LIMIT" };
    }
    return { status: "ok", mimeType: "image/png", width, height };
}

function png(bytes: Uint8Array, maxPixels: number): AttachmentValidation {
    if (bytes.length < 45 || be32(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
        return { status: "error", code: "MALFORMED_CONTENT" };
    }
    const dimensions = checkDimensions(be32(bytes, 16), be32(bytes, 20), maxPixels);
    if (dimensions.status === "error") return dimensions;
    const colourDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!colourDepths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) {
        return { status: "error", code: "MALFORMED_CONTENT" };
    }
    let offset = 8;
    let sawIdat = false;
    let sawIend = false;
    while (offset + 12 <= bytes.length) {
        const length = be32(bytes, offset);
        if (length > bytes.length - offset - 12) return { status: "error", code: "MALFORMED_CONTENT" };
        const kind = ascii(bytes, offset + 4, 4);
        if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== be32(bytes, offset + 8 + length)) {
            return { status: "error", code: "MALFORMED_CONTENT" };
        }
        if (kind === "acTL" || kind === "fcTL" || kind === "fdAT") return { status: "error", code: "UNSUPPORTED_CONTENT" };
        if (kind === "IDAT") sawIdat = true;
        if (kind === "IEND") { sawIend = length === 0 && offset + 12 === bytes.length; break; }
        offset += length + 12;
    }
    if (!sawIdat || !sawIend) return { status: "error", code: "MALFORMED_CONTENT" };
    return dimensions;
}

function jpeg(bytes: Uint8Array, maxPixels: number): AttachmentValidation {
    if (bytes.length < 6 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
        return { status: "error", code: "MALFORMED_CONTENT" };
    }
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) return { status: "error", code: "MALFORMED_CONTENT" };
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda) break; // Start of entropy-coded image data.
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.length) return { status: "error", code: "MALFORMED_CONTENT" };
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) return { status: "error", code: "MALFORMED_CONTENT" };
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
            if (length < 7) return { status: "error", code: "MALFORMED_CONTENT" };
            const result = checkDimensions((bytes[offset + 5] << 8) | bytes[offset + 6], (bytes[offset + 3] << 8) | bytes[offset + 4], maxPixels);
            return result.status === "ok" ? { ...result, mimeType: "image/jpeg" } : result;
        }
        offset += length;
    }
    return { status: "error", code: "MALFORMED_CONTENT" };
}

function webp(bytes: Uint8Array, maxPixels: number): AttachmentValidation {
    if (bytes.length < 30 || ascii(bytes, 8, 4) !== "WEBP" || le32(bytes, 4) + 8 !== bytes.length) {
        return { status: "error", code: "MALFORMED_CONTENT" };
    }
    let offset = 12;
    let width = 0, height = 0;
    let hasFrame = false;
    while (offset + 8 <= bytes.length) {
        const kind = ascii(bytes, offset, 4);
        const length = le32(bytes, offset + 4);
        const data = offset + 8;
        if (data + length > bytes.length) return { status: "error", code: "MALFORMED_CONTENT" };
        if (kind === "ANIM" || kind === "ANMF") return { status: "error", code: "UNSUPPORTED_CONTENT" };
        if (kind === "VP8X") {
            if (length !== 10 || (bytes[data] & 0x02) !== 0) return { status: "error", code: "UNSUPPORTED_CONTENT" };
            width = le24(bytes, data + 4) + 1; height = le24(bytes, data + 7) + 1;
        } else if (kind === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
            const frameWidth = ((bytes[data + 7] << 8) | bytes[data + 6]) & 0x3fff;
            const frameHeight = ((bytes[data + 9] << 8) | bytes[data + 8]) & 0x3fff;
            width ||= frameWidth; height ||= frameHeight; hasFrame = true;
        } else if (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
            const frameWidth = 1 + (bytes[data + 1] | ((bytes[data + 2] & 0x3f) << 8));
            const frameHeight = 1 + ((bytes[data + 2] >> 6) | (bytes[data + 3] << 2) | ((bytes[data + 4] & 0x0f) << 10));
            width ||= frameWidth; height ||= frameHeight; hasFrame = true;
        }
        offset = data + length + (length & 1);
    }
    if (offset !== bytes.length || !hasFrame) return { status: "error", code: "MALFORMED_CONTENT" };
    const result = checkDimensions(width, height, maxPixels);
    return result.status === "ok" ? { ...result, mimeType: "image/webp" } : result;
}

function pdf(bytes: Uint8Array): AttachmentValidation {
    if (bytes.length < 30 || !/^%PDF-[12]\.[0-9]/.test(ascii(bytes, 0, 8))) return { status: "error", code: "MALFORMED_CONTENT" };
    const tail = ascii(bytes, Math.max(0, bytes.length - 2048), Math.min(2048, bytes.length));
    const eof = tail.lastIndexOf("%%EOF");
    const xref = tail.lastIndexOf("startxref", eof);
    if (eof < 0 || xref < 0 || tail.slice(eof + 5).trim().length > 0) return { status: "error", code: "MALFORMED_CONTENT" };
    const offsetMatch = /^startxref\s+(\d+)\s*$/.exec(tail.slice(xref, eof).trim());
    if (!offsetMatch) return { status: "error", code: "MALFORMED_CONTENT" };
    const offset = Number(offsetMatch[1]);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) return { status: "error", code: "MALFORMED_CONTENT" };
    const start = ascii(bytes, offset, Math.min(40, bytes.length - offset));
    if (!start.startsWith("xref") && !/^\d+\s+\d+\s+obj\b/.test(start)) return { status: "error", code: "MALFORMED_CONTENT" };
    return { status: "ok", mimeType: "application/pdf" };
}

export function validateAttachment(bytes: Uint8Array, maxPixels: number): AttachmentValidation {
    if (bytes.length >= 8 && PNG_SIGNATURE.every((value, i) => bytes[i] === value)) return png(bytes, maxPixels);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes, maxPixels);
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webp(bytes, maxPixels);
    if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") return pdf(bytes);
    return { status: "error", code: "UNSUPPORTED_CONTENT" };
}
