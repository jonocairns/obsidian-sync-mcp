/**
 * Parse Obsidian markdown content for frontmatter, tags, and links.
 */

import { parse as parseYaml } from "yaml";
import { parseMarkdown, markdownReferences, markdownInlineTokens, type ParsedMarkdown } from "./markdown.js";

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
 *
 * Only decimal digits are rejected, though the tag class admits every
 * `\p{N}`. The asymmetry is deliberate: this rule exists to stop prose number
 * references becoming tags, and no one writes "PR #①②③", while `#½` and
 * `#Ⅷ` are plausible tags. Nl and No numerals are kept on purpose.
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

export function parseFrontmatterAndLinks(content: string | ParsedMarkdown): NoteMetadata {
    const document = typeof content === "string" ? parseMarkdown(content) : content;
    const frontmatter: Record<string, string> = {};
    const tags = new Set<string>();
    const links: string[] = [];
    const aliases = new Set<string>();
    const linkLabels = new Set<string>();

    if (document.frontmatter !== null) {
        try {
            const parsed: unknown = parseYaml(preserveObsidianTemplateScalars(document.frontmatter));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const fields = parsed as Record<string, unknown>;
                for (const [key, value] of Object.entries(fields)) {
                    frontmatter[key] = typeof value === "string" ? value : JSON.stringify(value);
                }
                for (const tag of stringList(fields.tags)) collectTag(tags, tag);
                for (const alias of [...stringList(fields.aliases), ...stringList(fields.alias)]) aliases.add(alias);
            }
        } catch {
            // Invalid frontmatter must not make the note itself unindexable.
        }
    }

    for (const token of markdownInlineTokens(document.tokens)) {
        if (token.type !== "text") continue;
        for (const match of token.content.matchAll(INLINE_TAG)) collectTag(tags, match[2]);
    }
    for (const reference of markdownReferences(document.tokens)) {
        // Preserve the existing scope: all wiki targets, and Markdown note links.
        if (reference.syntax === "markdown" && !reference.target.endsWith(".md")) continue;
        links.push(reference.target);
        linkLabels.add((reference.display ?? reference.target.split("/").pop() ?? reference.target).trim());
    }

    return {
        frontmatter,
        tags: [...tags],
        links: [...new Set(links)],
        aliases: [...aliases],
        linkLabels: [...linkLabels].filter(Boolean),
    };
}
