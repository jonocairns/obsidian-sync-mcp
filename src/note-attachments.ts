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

function referenceFrom(
    rawTarget: string, fragment: string | undefined,
    kind: NoteAttachmentReference["kind"], syntax: NoteAttachmentReference["syntax"], display?: string,
): NoteAttachmentReference | null {
    const target = rawTarget.trim();
    const mimeType = mimeTypeHint(target);
    if (!mimeType) return null;
    return {
        target, kind, syntax, mimeTypeHint: mimeType,
        ...(fragment ? { fragment } : {}), ...(display ? { display } : {}),
    };
}

function reference(
    destination: string, kind: NoteAttachmentReference["kind"], syntax: NoteAttachmentReference["syntax"], display?: string,
): NoteAttachmentReference | null {
    const hash = destination.indexOf("#");
    return referenceFrom(
        hash < 0 ? destination : destination.slice(0, hash),
        hash < 0 ? undefined : destination.slice(hash + 1) || undefined,
        kind, syntax, display,
    );
}

/** Longest destination a vault attachment link can hold; bounds work on malformed lines. */
const MAX_DESTINATION = 1024;

interface LineIndex {
    start: number;
    end: number;
    /** Offset of the matching "]" for the "[" at each position, or -1. Indexed from `start`. */
    match: Int32Array;
    /** Offset of the first unescaped "]]" at or after each position, or -1. Indexed from `start`. */
    wikiClose: Int32Array;
}

/**
 * Index one line's bracket structure in a single pass. Scanning ahead from every
 * unmatched "[" would cost quadratic time on a long malformed line, and deriving
 * escapes from the line start rather than from each candidate keeps one phase.
 */
function indexLine(input: string, start: number): LineIndex {
    const newline = input.indexOf("\n", start);
    const end = newline < 0 ? input.length : newline;
    const length = end - start;
    const escaped = new Uint8Array(length);
    for (let i = 0; i + 1 < length; i++) {
        if (input[start + i] === "\\" && !escaped[i]) escaped[i + 1] = 1;
    }
    const match = new Int32Array(length).fill(-1);
    const open: number[] = [];
    for (let i = 0; i < length; i++) {
        if (escaped[i]) continue;
        if (input[start + i] === "[") open.push(i);
        else if (input[start + i] === "]") {
            const opened = open.pop();
            if (opened !== undefined) match[opened] = start + i;
        }
    }
    const wikiClose = new Int32Array(length + 1).fill(-1);
    for (let i = length - 1; i >= 0; i--) {
        wikiClose[i] = i + 1 < length && !escaped[i] && input[start + i] === "]" && input[start + i + 1] === "]"
            ? start + i : wikiClose[i + 1];
    }
    return { start, end, match, wikiClose };
}

interface BacktickRuns {
    /** Start offset of each maximal unescaped backtick run. */
    starts: Int32Array;
    /** Backtick count of the run at the same index. */
    lengths: Int32Array;
    /** Index of the next run of equal length, or -1 when this run cannot be closed. */
    nextSame: Int32Array;
    /** Run index by start offset, so the scanner can tell a run start from its interior. */
    index: Map<number, number>;
}

/**
 * Index every unescaped backtick run in one pass. A code span closes only on a run
 * of exactly equal length, so an unmatched run is literal text rather than an open
 * span that swallows the rest of the note. Resolving that by lookup keeps the scan
 * linear instead of rescanning ahead from each candidate.
 */
function indexBacktickRuns(input: string): BacktickRuns {
    const starts: number[] = [];
    const lengths: number[] = [];
    for (let cursor = 0, escaped = false; cursor < input.length; cursor++) {
        if (escaped) { escaped = false; continue; }
        if (input[cursor] === "\\") { escaped = true; continue; }
        if (input[cursor] !== "`") continue;
        const length = runLength(input, cursor, "`");
        starts.push(cursor);
        lengths.push(length);
        cursor += length - 1;
    }
    const nextSame = new Int32Array(starts.length).fill(-1);
    const pending = new Map<number, number>();
    for (let i = starts.length - 1; i >= 0; i--) {
        nextSame[i] = pending.get(lengths[i]) ?? -1;
        pending.set(lengths[i], i);
    }
    const index = new Map<number, number>();
    for (let i = 0; i < starts.length; i++) index.set(starts[i], i);
    return { starts: Int32Array.from(starts), lengths: Int32Array.from(lengths), nextSame, index };
}

function wikiAt(input: string, offset: number, kind: NoteAttachmentReference["kind"], line: LineIndex):
    { end: number; value: NoteAttachmentReference | null } | null {
    const start = offset + (kind === "embed" ? 3 : 2);
    if (start > line.end) return null;
    const close = line.wikiClose[start - line.start];
    if (close < 0) return null;
    const raw = input.slice(start, close);
    const separator = raw.indexOf("|");
    const target = separator < 0 ? raw : raw.slice(0, separator);
    const display = separator < 0 ? undefined : raw.slice(separator + 1);
    return { end: close + 2, value: reference(target, kind, "wikilink", display) };
}

function unescapeMarkdown(input: string): string {
    let output = "";
    for (let cursor = 0; cursor < input.length; cursor++) {
        if (input[cursor] === "\\" && cursor + 1 < input.length) cursor++;
        output += input[cursor];
    }
    return output;
}

/**
 * Offset of a trailing CommonMark "(title)" run, or -1. Anchoring to the end keeps
 * real names such as `report (1).png` in the destination instead of reading them
 * as a title.
 */
function parenthesizedTitle(text: string): number {
    if (!text.endsWith(")")) return -1;
    let depth = 0;
    for (let cursor = text.length - 1; cursor >= 0; cursor--) {
        if (text[cursor] === ")") depth++;
        else if (text[cursor] === "(" && --depth === 0) return cursor;
    }
    return -1;
}

function markdownDestination(raw: string): { target: string; fragment?: string } | null {
    const text = raw.trim();
    let destination: string;
    if (text.startsWith("<")) {
        const close = text.indexOf(">");
        if (close < 0) return null;
        destination = text.slice(1, close);
    } else {
        const title = parenthesizedTitle(text);
        let end = text.length;
        for (let cursor = 0; cursor < text.length; cursor++) {
            if (text[cursor] === "\\") { cursor++; continue; }
            if (text[cursor] !== " " && text[cursor] !== "\t") continue;
            let next = cursor + 1;
            while (text[next] === " " || text[next] === "\t") next++;
            if (text[next] === '"' || text[next] === "'" || next === title) { end = cursor; break; }
        }
        destination = text.slice(0, end).trim();
    }
    if (!destination || destination.startsWith("//")) return null;
    destination = unescapeMarkdown(destination);
    if (URL.canParse(destination)) return null;
    // Split on a literal "#" before decoding. Decoding first turns a "%23" inside a
    // filename into a fragment separator and drops the reference entirely.
    const hash = destination.indexOf("#");
    const rawTarget = hash < 0 ? destination : destination.slice(0, hash);
    const rawFragment = hash < 0 ? "" : destination.slice(hash + 1);
    try {
        return {
            target: decodeURIComponent(rawTarget),
            ...(rawFragment ? { fragment: decodeURIComponent(rawFragment) } : {}),
        };
    } catch { return null; }
}

function markdownAt(input: string, offset: number, kind: NoteAttachmentReference["kind"], line: LineIndex):
    { end: number; value: NoteAttachmentReference | null } | null {
    const opening = offset + (kind === "embed" ? 1 : 0);
    if (opening < line.start || opening >= line.end) return null;
    const labelEnd = line.match[opening - line.start];
    if (labelEnd < 0 || input[labelEnd + 1] !== "(") return null;
    const display = input.slice(opening + 1, labelEnd);
    const destinationStart = labelEnd + 2;
    const limit = Math.min(line.end, destinationStart + MAX_DESTINATION);
    let cursor = destinationStart;
    let parentheses = 1;
    let angle = false;
    for (; cursor < limit; cursor++) {
        if (input[cursor] === "\\") { cursor++; continue; }
        if (input[cursor] === "<") angle = true;
        else if (input[cursor] === ">") angle = false;
        else if (!angle && input[cursor] === "(") parentheses++;
        else if (!angle && input[cursor] === ")" && --parentheses === 0) break;
    }
    if (parentheses !== 0) return null;
    const destination = markdownDestination(input.slice(destinationStart, cursor));
    return { end: cursor + 1, value: destination ? referenceFrom(destination.target, destination.fragment, kind, "markdown", display) : null };
}

/** Find supported vault attachment links without reading or resolving binary files. */
export function extractNoteAttachments(markdown: string): NoteAttachmentReference[] {
    const found: NoteAttachmentReference[] = [];
    const seen = new Set<string>();
    let fence: { marker: string; length: number } | null = null;
    const runs = indexBacktickRuns(markdown);
    let lineStart = true;
    let line: LineIndex | null = null;
    const lineFor = (offset: number): LineIndex => {
        if (!line || offset < line.start || offset > line.end) {
            line = indexLine(markdown, markdown.lastIndexOf("\n", offset - 1) + 1);
        }
        return line;
    };

    for (let cursor = 0; cursor < markdown.length;) {
        if (lineStart) {
            const marker = fenceAtLine(markdown, cursor);
            if (fence) {
                if (marker?.marker === fence.marker && marker.length >= fence.length &&
                    markdown.slice(marker.after, nextLine(markdown, cursor)).trim() === "") fence = null;
                cursor = nextLine(markdown, cursor);
                continue;
            }
            if (marker) {
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
            const run = runs.index.get(cursor);
            if (run === undefined) { cursor++; continue; }
            const close = runs.nextSame[run];
            if (close < 0) { cursor += runs.lengths[run]; continue; }
            // A closed span is skipped whole, so a fence marker inside it is never read
            // as a fence and the lines it covers are never scanned for links.
            cursor = runs.starts[close] + runs.lengths[close];
            lineStart = cursor === 0 || markdown[cursor - 1] === "\n";
            continue;
        }
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
                ? wikiAt(markdown, cursor, kind, lineFor(cursor))
                : markdownAt(markdown, cursor, kind, lineFor(cursor));
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
