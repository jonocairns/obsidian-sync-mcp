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

// 2×2 red images encoded by FFmpeg; kept as bytes so tests need no media tools.
export const smallJpeg = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z", "base64");
export const smallWebp = Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=", "base64");
