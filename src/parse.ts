/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

import { parse as parseYaml } from "yaml";

export interface NoteMetadata {
    frontmatter: Record<string, string>;
    tags: string[];
    links: string[];
    aliases: string[];
    linkLabels: string[];
}

/**
 * Obsidian tags accept any Unicode letter, number or mark, plus `_`, `-`, `/`
 * for nesting and emoji, so `#café` and `#日本語` are ordinary tags. An
 * ASCII-only class truncates them mid-word — `#café` indexes as `caf` and
 * `#日本語` vanishes — which invents a tag the vault never had. Emoji arrive as
 * sequences, so the class also carries the joiner, skin-tone modifiers and the
 * regional indicators that spell a flag; enclosing keycaps are marks already.
 */
const INLINE_TAG =
    /(^|\s)#([\p{L}\p{N}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D_/-]+)/gu;

/**
 * Obsidian requires every tag to contain at least one non-numerical character,
 * so `#1984` is not a tag but `#1984book` is. Without this guard the inline
 * `#tag` pattern captures ordinary prose references such as "PR #6553" or
 * "issue #27", which then pollute `list_tags` and make `list_notes(tag=...)`
 * match on something the vault never tagged. Digits are matched by script, so
 * `#١٩٨٤` is rejected for the same reason `#1984` is.
 */
function isTagName(value: string): boolean {
    return value.length > 0 && !/^\p{Nd}+$/u.test(value);
}

/**
 * Tags are compared and counted as written, so the two Unicode spellings of
 * `#café` must not become two tags in `list_tags`. NFC is a no-op for ASCII.
 */
function collectTag(tags: Set<string>, value: string): void {
    const tag = value.normalize("NFC");
    if (isTagName(tag)) tags.add(tag);
}

function stringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    if (typeof value !== "string") return value == null ? [] : [String(value)];
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Obsidian's core Templates plugin commonly leaves scalar placeholders such as
 * `created: {{date:YYYY-MM-DD}}` in template notes. YAML treats the double
 * braces as nested flow mappings and emits a process warning while converting
 * their collection keys to JavaScript strings. Quote only whole scalar values
 * so the placeholder remains searchable metadata with its original meaning.
 */
function preserveObsidianTemplateScalars(yaml: string): string {
    return yaml.split("\n").map((line) => {
        const match = line.match(/^(\s*[^#][^:\n]*:\s*)(\{\{.*\}\})(\s*(?:#.*)?)$/);
        if (!match) return line;
        return `${match[1]}${JSON.stringify(match[2])}${match[3]}`;
    }).join("\n");
}

export function parseFrontmatterAndLinks(content: string): NoteMetadata {
    const frontmatter: Record<string, string> = {};
    const tags = new Set<string>();
    const links: string[] = [];
    const aliases = new Set<string>();
    const linkLabels = new Set<string>();

    // Parse YAML frontmatter
    if (content.startsWith("---\n")) {
        const end = content.indexOf("\n---", 4);
        if (end !== -1) {
            try {
                const yaml = preserveObsidianTemplateScalars(content.slice(4, end));
                const parsed = parseYaml(yaml) as Record<string, unknown> | null;
                for (const [key, value] of Object.entries(parsed ?? {})) {
                    frontmatter[key] = typeof value === "string" ? value : JSON.stringify(value);
                }
                for (const tag of stringList(parsed?.tags)) collectTag(tags, tag);
                for (const alias of [
                    ...stringList(parsed?.aliases),
                    ...stringList(parsed?.alias),
                ]) {
                    aliases.add(alias);
                }
            } catch {
                // Invalid frontmatter must not make the note itself unindexable.
            }
        }
    }

    // Inline #tags
    for (const match of content.matchAll(INLINE_TAG)) {
        collectTag(tags, match[2]);
    }

    // [[wikilinks]]
    for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
        const target = match[1].trim();
        links.push(target);
        linkLabels.add((match[2] ?? target.split("/").pop() ?? target).trim());
    }

    // [markdown links](path.md)
    for (const match of content.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g)) {
        links.push(match[2]);
        linkLabels.add(match[1].trim());
    }

    return {
        frontmatter,
        tags: [...tags],
        links: [...new Set(links)],
        aliases: [...aliases],
        linkLabels: [...linkLabels].filter(Boolean),
    };
}

export function extractSnippet(content: string, query: string, context = 80): string {
    const lower = content.toLowerCase();

    // Try exact phrase first
    let idx = lower.indexOf(query.toLowerCase());

    // Try to find the smallest span containing all query words
    if (idx === -1) {
        const words = query.split(/\s+/).filter((w) => w.length >= 3).map((w) => w.toLowerCase());
        if (words.length > 1) {
            let bestStart = -1;
            let bestLen = Infinity;
            // For each occurrence of the first word, find the nearest span containing all words
            const first = words[0];
            let pos = 0;
            while (pos < lower.length) {
                const start = lower.indexOf(first, pos);
                if (start === -1) break;
                // Find last position needed to include all words from this start
                let spanEnd = start + first.length;
                let allFound = true;
                for (let i = 1; i < words.length; i++) {
                    const wi = lower.indexOf(words[i], Math.max(0, start - 200));
                    if (wi === -1) { allFound = false; break; }
                    spanEnd = Math.max(spanEnd, wi + words[i].length);
                }
                if (allFound) {
                    const spanStart = Math.min(start, ...words.map((w) => lower.indexOf(w, Math.max(0, start - 200))).filter((i) => i >= 0));
                    const len = spanEnd - spanStart;
                    if (len < bestLen) { bestStart = spanStart; bestLen = len; }
                }
                pos = start + 1;
            }
            if (bestStart >= 0 && bestLen <= 500) idx = bestStart;
        }
    }

    // Fall back to longest matching word
    if (idx === -1) {
        const words = query.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
        for (const word of words) {
            idx = lower.indexOf(word.toLowerCase());
            if (idx !== -1) break;
        }
    }

    if (idx === -1) {
        return content.slice(0, 160) + (content.length > 160 ? "..." : "");
    }
    const start = Math.max(0, idx - context);
    const end = Math.min(content.length, idx + query.length + context);
    return (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
}
