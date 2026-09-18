import { posix } from "node:path";

export interface NoteAttachmentReference {
    target: string;
    kind: "embed" | "link";
    syntax: "wikilink" | "markdown";
    mimeTypeHint: "image/png" | "image/jpeg" | "image/webp" | "application/pdf";
    fragment?: string;
    display?: string;
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

function runLength(input: string, offset: number, character: string): number {
    let length = 0;
    while (input[offset + length] === character) length++;
    return length;
}

function fenceAtLine(input: string, offset: number): { marker: string; length: number; after: number } | null {
    let cursor = offset;
    while (cursor - offset < 4 && input[cursor] === " ") cursor++;
    if (cursor - offset > 3) return null;
    const marker = input[cursor];
    if (marker !== "`" && marker !== "~") return null;
    const length = runLength(input, cursor, marker);
    return length >= 3 ? { marker, length, after: cursor + length } : null;
}

function nextLine(input: string, offset: number): number {
    const end = input.indexOf("\n", offset);
    return end < 0 ? input.length : end + 1;
}

function reference(
    destination: string, kind: NoteAttachmentReference["kind"], syntax: NoteAttachmentReference["syntax"], display?: string,
): NoteAttachmentReference | null {
    const hash = destination.indexOf("#");
    const target = (hash < 0 ? destination : destination.slice(0, hash)).trim();
    const mimeType = mimeTypeHint(target);
    if (!mimeType) return null;
    const fragment = hash < 0 ? undefined : destination.slice(hash + 1) || undefined;
    return {
        target, kind, syntax, mimeTypeHint: mimeType,
        ...(fragment ? { fragment } : {}), ...(display ? { display } : {}),
    };
}

function wikiAt(input: string, offset: number, kind: NoteAttachmentReference["kind"]):
    { end: number; value: NoteAttachmentReference | null } | null {
    const start = offset + (kind === "embed" ? 3 : 2);
    for (let cursor = start; cursor < input.length && input[cursor] !== "\n"; cursor++) {
        if (input[cursor] === "\\") { cursor++; continue; }
        if (input[cursor] !== "]" || input[cursor + 1] !== "]") continue;
        const raw = input.slice(start, cursor);
        const separator = raw.indexOf("|");
        const target = separator < 0 ? raw : raw.slice(0, separator);
        const display = separator < 0 ? undefined : raw.slice(separator + 1);
        return { end: cursor + 2, value: reference(target, kind, "wikilink", display) };
    }
    return null;
}

function unescapeMarkdown(input: string): string {
    let output = "";
    for (let cursor = 0; cursor < input.length; cursor++) {
        if (input[cursor] === "\\" && cursor + 1 < input.length) cursor++;
        output += input[cursor];
    }
    return output;
}

function markdownDestination(raw: string): string | null {
    const text = raw.trim();
    let destination: string;
    if (text.startsWith("<")) {
        const close = text.indexOf(">");
        if (close < 0) return null;
        destination = text.slice(1, close);
    } else {
        let end = text.length;
        for (let cursor = 0; cursor < text.length; cursor++) {
            if (text[cursor] === "\\") { cursor++; continue; }
            if (text[cursor] !== " " && text[cursor] !== "\t") continue;
            let next = cursor + 1;
            while (text[next] === " " || text[next] === "\t") next++;
            if (text[next] === '"' || text[next] === "'") { end = cursor; break; }
        }
        destination = text.slice(0, end).trim();
    }
    if (!destination || destination.startsWith("//")) return null;
    destination = unescapeMarkdown(destination);
    if (URL.canParse(destination)) return null;
    try { return decodeURIComponent(destination); }
    catch { return null; }
}

function markdownAt(input: string, offset: number, kind: NoteAttachmentReference["kind"]):
    { end: number; value: NoteAttachmentReference | null } | null {
    const labelStart = offset + (kind === "embed" ? 2 : 1);
    let cursor = labelStart;
    let brackets = 1;
    for (; cursor < input.length && input[cursor] !== "\n"; cursor++) {
        if (input[cursor] === "\\") { cursor++; continue; }
        if (input[cursor] === "[") brackets++;
        if (input[cursor] === "]" && --brackets === 0) break;
    }
    if (brackets !== 0 || input[cursor + 1] !== "(") return null;
    const display = input.slice(labelStart, cursor);
    const destinationStart = cursor + 2;
    let parentheses = 1;
    let angle = false;
    for (cursor = destinationStart; cursor < input.length && input[cursor] !== "\n"; cursor++) {
        if (input[cursor] === "\\") { cursor++; continue; }
        if (input[cursor] === "<") angle = true;
        else if (input[cursor] === ">") angle = false;
        else if (!angle && input[cursor] === "(") parentheses++;
        else if (!angle && input[cursor] === ")" && --parentheses === 0) break;
    }
    if (parentheses !== 0) return null;
    const destination = markdownDestination(input.slice(destinationStart, cursor));
    return { end: cursor + 1, value: destination ? reference(destination, kind, "markdown", display) : null };
}

/** Find supported vault attachment links without reading or resolving binary files. */
export function extractNoteAttachments(markdown: string): NoteAttachmentReference[] {
    const found: NoteAttachmentReference[] = [];
    const seen = new Set<string>();
    let fence: { marker: string; length: number } | null = null;
    let inlineTicks = 0;
    let lineStart = true;

    for (let cursor = 0; cursor < markdown.length;) {
        if (lineStart) {
            const marker = fenceAtLine(markdown, cursor);
            if (fence) {
                if (marker?.marker === fence.marker && marker.length >= fence.length &&
                    markdown.slice(marker.after, nextLine(markdown, cursor)).trim() === "") fence = null;
                cursor = nextLine(markdown, cursor);
                continue;
            }
            if (!inlineTicks && marker) {
                fence = marker;
                cursor = nextLine(markdown, cursor);
                continue;
            }
            lineStart = false;
        }
        const character = markdown[cursor];
        if (character === "\n") { cursor++; lineStart = true; continue; }
        if (character === "\\") { cursor += markdown[cursor + 1] === "\n" ? 1 : 2; continue; }
        if (character === "`") {
            const ticks = runLength(markdown, cursor, "`");
            if (!inlineTicks) inlineTicks = ticks;
            else if (inlineTicks === ticks) inlineTicks = 0;
            cursor += ticks;
            continue;
        }
        if (inlineTicks) { cursor++; continue; }
        if (markdown.startsWith("<!--", cursor)) {
            const end = markdown.indexOf("-->", cursor + 4);
            cursor = end < 0 ? markdown.length : end + 3;
            lineStart = cursor === 0 || markdown[cursor - 1] === "\n";
            continue;
        }
        const kind = character === "!" ? "embed" : "link";
        const opening = kind === "embed" ? cursor + 1 : cursor;
        if (markdown[opening] === "[") {
            const parsed = markdown[opening + 1] === "["
                ? wikiAt(markdown, cursor, kind) : markdownAt(markdown, cursor, kind);
            if (parsed) {
                if (parsed.value) {
                    const key = JSON.stringify(parsed.value);
                    if (!seen.has(key)) { seen.add(key); found.push(parsed.value); }
                }
                cursor = parsed.end;
                continue;
            }
        }
        cursor++;
    }
    return found;
}
