import { posix } from "node:path";

const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf"]);

export function validVaultPath(path: string): boolean {
    const segments = path.split("/");
    return Boolean(path) && path.length <= 1000 && !path.startsWith("/") &&
        !path.includes("\\") && !path.includes("\0") &&
        segments.every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".obsidian" && part.toLowerCase() !== ".trash");
}

export function validAttachmentPath(path: string): boolean {
    return validVaultPath(path) && EXTENSIONS.has(posix.extname(path).toLowerCase());
}

export function validSourceNotePath(path: string): boolean {
    return validVaultPath(path) && path.endsWith(".md");
}
