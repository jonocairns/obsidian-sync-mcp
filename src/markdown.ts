import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { frontmatterBoundary } from "./frontmatter.js";

export interface MarkdownReference {
    target: string;
    kind: "embed" | "link";
    syntax: "wikilink" | "markdown";
    fragment?: string;
    display?: string;
}
export interface ParsedMarkdown {
    frontmatter: string | null;
    body: string;
    tokens: Token[];
}

// Obsidian's inline syntax is the only grammar we own. Excluding nested brackets
// keeps failed matches from repeatedly scanning the same malformed bracket run.
const WIKILINK = /(!?)\[\[([^[\]\r\n]+)\]\]/y;
function wikilink(state: StateInline, silent: boolean): boolean {
    WIKILINK.lastIndex = state.pos;
    const match = WIKILINK.exec(state.src);
    if (!match || WIKILINK.lastIndex > state.posMax) return false;
    if (!silent) {
        const token = state.push("obsidian_link", "", 0);
        token.markup = match[1];
        const separator = match[2].indexOf("|");
        token.attrSet("target", separator < 0 ? match[2] : match[2].slice(0, separator));
        token.content = separator < 0 ? "" : match[2].slice(separator + 1);
    }
    state.pos = WIKILINK.lastIndex;
    return true;
}

// Parse only: HTML tokens let us ignore comments and HTML blocks without scanning
// their contents ourselves. No renderer is called and no HTML is executed.
const parser = new MarkdownIt({ html: true });
parser.inline.ruler.before("link", "obsidian_link", wikilink);

// Keep escaped text distinct so a literal \#example cannot become a tag.
parser.core.ruler.disable("text_join");

export function parseMarkdown(content: string): ParsedMarkdown {
    const boundary = frontmatterBoundary(content);
    const body = content.slice(boundary?.bodyStart ?? 0).replace(/\r\n?/g, "\n");
    return { frontmatter: boundary?.yaml ?? null, body, tokens: parser.parse(body, {}) };
}

/** Inline tokens only; image alt text is descriptive text, not more vault links. */
export function* markdownInlineTokens(tokens: Token[]): Generator<Token> {
    for (const token of tokens) {
        yield token;
        if (token.children && token.type !== "image") yield* markdownInlineTokens(token.children);
    }
}

function reference(
    destination: string, kind: MarkdownReference["kind"],
    syntax: MarkdownReference["syntax"], display: string,
): MarkdownReference | null {
    if (!destination || destination.startsWith("//") || URL.canParse(destination)) return null;
    const hash = destination.indexOf("#");
    let target = (hash < 0 ? destination : destination.slice(0, hash)).trim();
    let fragment = hash < 0 ? "" : destination.slice(hash + 1);
    // Markdown destinations are URLs; wiki destinations are literal vault names.
    // Split before decoding so %23 in a filename never becomes a fragment.
    if (syntax === "markdown") {
        try { target = decodeURIComponent(target); fragment = decodeURIComponent(fragment); }
        catch { return null; }
    }
    if (!target) return null;
    return { target, kind, syntax,
        ...(fragment ? { fragment } : {}), ...(display ? { display } : {}),
    };
}

function linkDisplay(tokens: Token[], start: number): string {
    let display = "";
    for (let i = start + 1; i < tokens.length && tokens[i].type !== "link_close"; i++) {
        const token = tokens[i];
        if (token.type === "text" || token.type === "text_special" || token.type === "code_inline" || token.type === "image") display += token.content;
        else if (token.type === "softbreak" || token.type === "hardbreak") display += "\n";
    }
    return display;
}

export function markdownReferences(tokens: Token[]): MarkdownReference[] {
    const references: MarkdownReference[] = [];
    function visit(tokens: Token[]): void {
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            let value: MarkdownReference | null = null;
            if (token.type === "obsidian_link") {
                value = reference(token.attrGet("target")!, token.markup === "!" ? "embed" : "link", "wikilink", token.content);
            } else if (token.type === "image") {
                value = reference(token.attrGet("src")!, "embed", "markdown", token.content);
            } else if (token.type === "link_open") {
                value = reference(token.attrGet("href")!, "link", "markdown", linkDisplay(tokens, i));
            } else if (token.children) visit(token.children);
            if (value) references.push(value);
        }
    }
    visit(tokens);
    return references;
}

/** Top-level headings and their source lines; nested examples stay in their block. */
export function markdownHeadings(tokens: Token[]) {
    return tokens.flatMap((token, i) => {
        if (token.type !== "heading_open" || token.level !== 0 || !token.map) return [];
        const text = [...markdownInlineTokens(tokens[i + 1]?.children ?? [])].map((part) => {
            if (part.type === "obsidian_link") return part.content || part.attrGet("target") || "";
            return ["text", "text_special", "code_inline", "image"].includes(part.type) ? part.content : "";
        }).join("");
        return [{ level: Number(token.tag.slice(1)), text, start: token.map[0], end: token.map[1] }];
    });
}
