import { parseMarkdown, markdownHeadings, type ParsedMarkdown } from "./markdown.js";

/** A compact, deterministic representation of one searchable Markdown section. */
export interface MarkdownChunk {
    ordinal: number;
    heading: string;
    breadcrumb: string;
    body: string;
}

const TARGET_WORDS = 400;
const MAX_WORDS = 800;

function wordCount(value: string): number {
    return value.match(/\S+/g)?.length ?? 0;
}

function splitOversizedBody(body: string): string[] {
    const normalized = body.trim();
    if (!normalized) return [];
    if (wordCount(normalized) <= MAX_WORDS) return [normalized];

    const pieces: string[] = [];
    let current: string[] = [];
    let currentWords = 0;
    const paragraphs = normalized.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);

    const flush = () => {
        if (current.length > 0) pieces.push(current.join("\n\n"));
        current = [];
        currentWords = 0;
    };

    for (const paragraph of paragraphs) {
        const count = wordCount(paragraph);
        if (count > MAX_WORDS) {
            flush();
            const words = paragraph.match(/\S+/g) ?? [];
            for (let offset = 0; offset < words.length; offset += MAX_WORDS) {
                pieces.push(words.slice(offset, offset + MAX_WORDS).join(" "));
            }
            continue;
        }
        if (currentWords >= TARGET_WORDS && currentWords + count > MAX_WORDS) flush();
        current.push(paragraph);
        currentWords += count;
    }
    flush();
    return pieces;
}

/** Split at parsed headings; preserve source text and the existing word budget. */
export function chunkMarkdown(content: string | ParsedMarkdown): MarkdownChunk[] {
    const parsed = typeof content === "string" ? parseMarkdown(content) : content;
    const lines = parsed.body.split("\n");
    const headings: string[] = [];
    const chunks: MarkdownChunk[] = [];
    let start = 0;
    let heading = "";
    let breadcrumb = "";
    const append = (end: number) => {
        for (const body of splitOversizedBody(lines.slice(start, end).join("\n"))) {
            chunks.push({ ordinal: chunks.length, heading, breadcrumb, body });
        }
    };
    for (const section of markdownHeadings(parsed.tokens)) {
        append(section.start);
        headings.length = section.level - 1;
        headings[section.level - 1] = section.text;
        heading = section.text;
        breadcrumb = headings.filter(Boolean).join(" > ");
        start = section.end;
    }
    append(lines.length);
    return chunks;
}
