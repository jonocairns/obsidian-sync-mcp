export interface FrontmatterBoundary {
    yaml: string;
    /** Offset in the original string, including the closing delimiter's newline. */
    bodyStart: number;
}

/** Locate a leading YAML block without parsing or rewriting any source bytes. */
export function frontmatterBoundary(content: string): FrontmatterBoundary | null {
    const opening = /^(?:\uFEFF)?---[\t ]*\r?\n/.exec(content);
    if (!opening) return null;
    const closing = /^---[\t ]*(?:\r?\n|$)/gm;
    closing.lastIndex = opening[0].length;
    const match = closing.exec(content);
    if (!match) return null;
    return { yaml: content.slice(opening[0].length, match.index), bodyStart: closing.lastIndex };
}
