import { posix } from "node:path";
import { parseMarkdown, markdownReferences, type ParsedMarkdown, type MarkdownReference } from "./markdown.js";

export interface NoteAttachmentReference extends MarkdownReference {
    mimeTypeHint: "image/png" | "image/jpeg" | "image/webp" | "application/pdf";
}

function mimeTypeHint(target: string): NoteAttachmentReference["mimeTypeHint"] | null {
    switch (posix.extname(target).toLowerCase()) {
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".webp": return "image/webp";
        case ".pdf": return "application/pdf";
        default: return null;
    }
}

/** Find supported vault attachment links without reading or resolving binary files. */
export function extractNoteAttachments(content: string | ParsedMarkdown): NoteAttachmentReference[] {
    const parsed = typeof content === "string" ? parseMarkdown(content) : content;
    const found: NoteAttachmentReference[] = [];
    const seen = new Set<string>();
    for (const reference of markdownReferences(parsed.tokens)) {
        const mimeType = mimeTypeHint(reference.target);
        if (!mimeType) continue;
        const value = { ...reference, mimeTypeHint: mimeType };
        const key = JSON.stringify(value);
        if (!seen.has(key)) { seen.add(key); found.push(value); }
    }
    return found;
}
