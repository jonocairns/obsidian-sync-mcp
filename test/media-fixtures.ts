import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(name: string, data: Uint8Array): Buffer {
    const label = Buffer.from(name);
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    label.copy(result, 4);
    Buffer.from(data).copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([label, Buffer.from(data)])), 8 + data.length);
    return result;
}
export function onePixelPng(rgb: [number, number, number] = [255, 0, 0]): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(Buffer.from([0, ...rgb]))),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}
/** A structurally valid PNG whose IHDR declares `width`x`height`; the pixel data is not decoded. */
export function pngWithDimensions(width: number, height: number): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}
export function minimalPdf(): Buffer {
    let text = "%PDF-1.4\n";
    const offsets = [0];
    for (const body of [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
    ]) { offsets.push(Buffer.byteLength(text)); text += body; }
    const xref = Buffer.byteLength(text);
    text += `xref\n0 3\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    text += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(text);
}

function riffChunk(id: string, data: Buffer): Buffer {
    const header = Buffer.alloc(8);
    header.write(id, 0, "latin1");
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** A still WebP hiding a 16000×16000 VP8L behind a trailing 2×2 one; only the last was measured. */
export function webpWithTwoFrames(): Buffer {
    const big = Buffer.from([0x2f, 0x7f, 0xfe, 0x9f, 0x0f, 0x00, 0x00, 0x00]);
    const small = Buffer.from([0x2f, 0x01, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const body = Buffer.concat([
        Buffer.from("WEBP", "latin1"),
        riffChunk("VP8L", big),
        riffChunk("VP8L", small),
    ]);
    const riff = Buffer.alloc(8);
    riff.write("RIFF", 0, "latin1");
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
}

/** A structurally valid PDF padded to roughly `totalBytes`, for exercising byte limits. */
export function paddedPdf(totalBytes: number): Buffer {
    const filler = "0".repeat(Math.max(0, totalBytes - 400));
    let text = "%PDF-1.4\n";
    const offsets = [0];
    for (const body of [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        `2 0 obj\n<< /Type /Pages /Kids [] /Count 0 /Pad (${filler}) >>\nendobj\n`,
    ]) { offsets.push(Buffer.byteLength(text)); text += body; }
    const xref = Buffer.byteLength(text);
    text += `xref\n0 3\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    text += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(text);
}

/** WebP whose VP8X canvas claims 1×1 while the VP8L frame really declares 16000×16000. */
export function webpWithOversizedFrame(): Buffer {
    const vp8l = Buffer.from([0x2f, 0x7f, 0xfe, 0x9f, 0x0f, 0x00, 0x00, 0x00]);
    const body = Buffer.concat([
        Buffer.from("WEBP", "latin1"),
        riffChunk("VP8X", Buffer.alloc(10)),
        riffChunk("VP8L", vp8l),
    ]);
    const riff = Buffer.alloc(8);
    riff.write("RIFF", 0, "latin1");
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
}

// 2×2 red images encoded by FFmpeg; kept as bytes so tests need no media tools.
export const smallJpeg = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z", "base64");
export const smallWebp = Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=", "base64");

// --- Composable builders, so a corpus can vary one property at a time ---

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Assembles a PNG from named chunks; each chunk's CRC is computed correctly. */
export function pngFile(chunks: [string, Uint8Array][]): Buffer {
    return Buffer.concat([PNG_SIGNATURE, ...chunks.map(([name, data]) => pngChunk(name, data))]);
}

export function ihdr(width: number, height: number, depth = 8, colour = 2): Buffer {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(width, 0);
    data.writeUInt32BE(height, 4);
    data[8] = depth; data[9] = colour;
    return data;
}

export const idat = () => deflateSync(Buffer.from([0, 0, 0, 0]));

/** Assembles a RIFF/WEBP file from named chunks, with the container size filled in. */
export function webpFile(chunks: [string, Buffer][]): Buffer {
    const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks.map(([id, data]) => riffChunk(id, data))]);
    const riff = Buffer.alloc(8);
    riff.write("RIFF", 0, "latin1");
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
}

/**
 * VP8L bitstream header declaring `width`x`height` (14 bits each, stored 0-based),
 * padded to the size a real encoder emits so the file clears the container's minimum.
 */
export function vp8lPayload(width: number, height: number): Buffer {
    const w = width - 1, h = height - 1;
    const header = [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f];
    return Buffer.concat([Buffer.from(header), Buffer.alloc(16)]);
}

/** VP8 (lossy) bitstream header declaring `width`x`height`, including the sync code. */
export function vp8Payload(width: number, height: number): Buffer {
    return Buffer.from([
        0, 0, 0, 0x9d, 0x01, 0x2a,
        width & 0xff, (width >> 8) & 0x3f,
        height & 0xff, (height >> 8) & 0x3f,
    ]);
}

/** VP8X extended-format header declaring a canvas; `flags` bit 1 marks animation. */
export function vp8xPayload(width: number, height: number, flags = 0): Buffer {
    const data = Buffer.alloc(10);
    data[0] = flags;
    data.writeUIntLE(width - 1, 4, 3);
    data.writeUIntLE(height - 1, 7, 3);
    return data;
}
