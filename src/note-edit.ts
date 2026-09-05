export type EditOperation = "replace_all" | "append" | "prepend_body" | "replace_once";
export type EditResult = { ok: true; content: string; replacements: number } | { ok: false; code: "LITERAL_NOT_FOUND" | "LITERAL_AMBIGUOUS"; matches: number };

function literalCount(value: string, needle: string): number {
    if (needle === "") return 0;
    let count = 0;
    let from = 0;
    while (true) {
        const at = value.indexOf(needle, from);
        if (at === -1) return count;
        count++;
        from = at + needle.length;
    }
}

/** Exact transformations: never inserts, removes, or normalises a newline. */
export function applyNoteEdit(existing: string, operation: EditOperation, content: string, oldText?: string): EditResult {
    if (operation === "replace_all") return { ok: true, content, replacements: 1 };
    if (operation === "append") return { ok: true, content: existing + content, replacements: 0 };
    if (operation === "prepend_body") {
        const frontmatter = existing.match(/^(?:\uFEFF)?---(?:\r\n|\n)[\s\S]*?(?:\r\n|\n)---(?:\r\n|\n)/);
        const at = frontmatter?.[0].length ?? 0;
        return { ok: true, content: existing.slice(0, at) + content + existing.slice(at), replacements: 0 };
    }
    const needle = oldText ?? "";
    const matches = literalCount(existing, needle);
    if (matches === 0) return { ok: false, code: "LITERAL_NOT_FOUND", matches };
    if (matches !== 1) return { ok: false, code: "LITERAL_AMBIGUOUS", matches };
    const at = existing.indexOf(needle);
    return { ok: true, content: existing.slice(0, at) + content + existing.slice(at + needle.length), replacements: 1 };
}
