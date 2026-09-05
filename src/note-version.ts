import { createHash } from "node:crypto";

export const NOTE_VERSION_PREFIX = "nv1.";

export type VersionState = Readonly<{
    backend: string;
    path: string;
    state: "exists" | "deleted";
    mutation: unknown;
}>;

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
}

export function encodeNoteVersion(state: VersionState): string {
    const canonical = canonicalJson({ domain: "obsidian-sync-mcp/note-version", codec: 1, ...state });
    return NOTE_VERSION_PREFIX + createHash("sha256").update(canonical).digest("base64url");
}

export function isOpaqueNoteVersion(value: string): boolean {
    return /^nv1\.[A-Za-z0-9_-]{43}$/.test(value);
}
