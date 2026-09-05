import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import type { BackendEffect, BackendFailureCode, BackendMutationResult, VaultBackend } from "./vault-backend.js";
import type { SearchBuildStatus, SearchIndex } from "./search.js";
import { isPathWritable } from "./write-scope.js";
import { applyNoteEdit } from "./note-edit.js";
import { domainError, recovery, schemaVersion, structuredNoteOutputSchema, toToolResult, type ErrorCode, type StructuredNoteResult } from "./note-contract.js";
import { parseFrontmatterAndLinks } from "./parse.js";

const debugLogging = process.env.LOG_LEVEL === "debug";
const markdownDecoder = new TextDecoder("utf-8", { fatal: true });

const WRITE_TOOLS = ["create_note", "edit_note", "delete_note", "move_note"] as const;

function recoveryFor(code: BackendFailureCode | ErrorCode) {
    if (code === "STALE_VERSION") return recovery("read_then_retry", "Read the note again and decide whether to retry with the fresh version.");
    if (code === "PRE_EXISTING_CONFLICT") return recovery("manual_reconcile", "Reconcile the note's existing CouchDB conflict branches before another mutation.");
    if (code === "DESTINATION_EXISTS") return recovery("change_request", "Choose a different destination or explicitly reconcile the existing note.");
    if (code === "RESTORE_REQUIRED") return recovery("change_request", "This path is logically deleted or tombstoned and requires a future explicit restore workflow.");
    if (code === "NOTE_NOT_FOUND") return recovery("change_request", "Check the path or create the note.");
    if (code === "INVALID_PATH" || code === "WRITE_DENIED") return recovery("change_request", "Use a valid writable vault-relative Markdown path.");
    if (code === "LITERAL_NOT_FOUND" || code === "LITERAL_AMBIGUOUS") return recovery("change_request", "Change old_text or choose another explicit edit operation.");
    if (code === "BACKEND_UNAVAILABLE") return recovery("retry_same", "Retry after the vault backend is available.");
    return recovery("none", "Inspect the server failure before retrying.");
}

function messageFor(code: BackendFailureCode | ErrorCode): string {
    return ({
        INVALID_PATH: "The note path is invalid.",
        NOTE_NOT_FOUND: "The note does not exist.",
        WRITE_DENIED: "The note path is outside the configured writable folders.",
        STALE_VERSION: "The note changed after the supplied version was read.",
        PRE_EXISTING_CONFLICT: "The note already has unresolved CouchDB conflict branches.",
        DESTINATION_EXISTS: "The destination already exists.",
        RESTORE_REQUIRED: "The note is logically deleted or tombstoned.",
        LITERAL_NOT_FOUND: "The literal old_text was not found.",
        LITERAL_AMBIGUOUS: "The literal old_text matched more than once.",
        BACKEND_UNAVAILABLE: "The vault backend could not complete the operation.",
        INTERNAL_ERROR: "The operation failed internally.",
    })[code];
}

function publicError(code: BackendFailureCode | ErrorCode): StructuredNoteResult {
    const next = recoveryFor(code);
    return domainError(code, messageFor(code), next.strategy, next.guidance);
}

type PublicEffect = {
    kind: BackendEffect["kind"] | "index_updated";
    path: string;
    completed: boolean;
};
function effectsOf(effects: BackendEffect[]): PublicEffect[] {
    return effects.map((effect) => ({ ...effect }));
}

function indexFreshness(searchIndex: SearchIndex): "current" | "building" | "catching_up" | "stale" {
    const state = searchIndex.status.state;
    if (state === "ready") return "current";
    if (state === "error") return "stale";
    return state;
}

export function formatIndexStatusNotice(status: SearchBuildStatus): string {
    if (status.state === "ready") return "";
    if (status.state === "error") {
        return "⚠ Search index update failed. Index-backed results, counts, and backlinks may be stale or incomplete.";
    }
    const progress = status.total && status.total > 0
        ? ` (${Math.min(100, Math.round(status.processed / status.total * 100))}% complete)`
        : status.processed > 0 ? ` (${status.processed} changes processed)` : "";
    return status.state === "building"
        ? `⚠ Search index is building${progress}. Index-backed results, counts, and backlinks are incomplete.`
        : `⚠ Search index is catching up${progress}. Index-backed results, counts, and backlinks may omit recent changes.`;
}

function withIndexStatusNotice(value: string, searchIndex: SearchIndex): string {
    const notice = formatIndexStatusNotice(searchIndex.status);
    return notice ? `${notice}\n\n${value}` : value;
}

export function registerTools(
    server: FastMCP,
    vault: VaultBackend,
    searchIndex: SearchIndex,
    vaultName: string,
    readOnly = false,
    writeFolders: string[] | null = null,
) {
    if (readOnly) {
        console.log(`READ_ONLY mode: write tools disabled (${WRITE_TOOLS.join(", ")}).`);
    } else if (writeFolders) {
        console.log(`WRITE_FOLDERS: writes restricted to ${writeFolders.length} configured folder(s) (paths redacted).`);
    }
    const writeScopeNote = writeFolders
        ? ` Writes are only allowed inside: ${writeFolders.map((f) => f + "/").join(", ")}.`
        : "";
    const _addTool = server.addTool.bind(server);
    async function finishMutation(
        operation: "create" | "edit" | "delete" | "move",
        path: string,
        destinationPath: string | undefined,
        oldVersion: string | undefined,
        content: string | undefined,
        replacements: number | undefined,
        backend: BackendMutationResult,
    ) {
        const effects = effectsOf(backend.effects);
        let indexState: "current" | "stale" = "current";
        if (backend.effects.some((effect) => effect.completed)) {
            try {
                if (operation === "delete" && backend.effects.some((effect) => effect.kind === "note_deleted" && effect.completed)) {
                    searchIndex.remove(path);
                } else if (operation === "move") {
                    if (backend.effects.some((effect) => effect.kind === "source_deleted" && effect.completed)) searchIndex.remove(path);
                    if (content !== undefined && destinationPath && backend.effects.some((effect) => effect.kind === "destination_created" && effect.completed)) {
                        searchIndex.update(destinationPath, content, ("note" in backend ? backend.note?.mtime : undefined) ?? Date.now());
                    }
                } else if (content !== undefined) {
                    searchIndex.update(path, content, ("note" in backend ? backend.note?.mtime : undefined) ?? Date.now());
                }
                effects.push({ kind: "index_updated", path: destinationPath ?? path, completed: true });
            } catch {
                indexState = "stale";
                effects.push({ kind: "index_updated", path: destinationPath ?? path, completed: false });
            }
        }
        if (backend.status === "error") return toToolResult(publicError(backend.code));
        if (backend.status === "conflict") {
            const next = recoveryFor(backend.code);
            const value: StructuredNoteResult = {
                schemaVersion, status: "conflict", error: { code: backend.code, message: messageFor(backend.code) },
                effects, recovery: next,
            };
            return toToolResult(value);
        }
        if (backend.status === "partial") {
            const next = recoveryFor(backend.code);
            const value: StructuredNoteResult = {
                schemaVersion, status: "partial", effects,
                error: { code: backend.code, message: messageFor(backend.code) },
                warning: "The move was not atomic; only the completed effects listed here are known to have committed.",
                recovery: next,
            };
            return toToolResult(value);
        }
        if (backend.status === "indeterminate") {
            const value: StructuredNoteResult = {
                schemaVersion, status: "indeterminate", effects,
                error: { code: "BACKEND_UNAVAILABLE", message: "The backend response was lost before commit state could be proven." },
                warning: "Do not repeat the mutation blindly because it may already have committed.",
                recovery: recovery("read_then_retry", "Read every affected path authoritatively before deciding whether another mutation is safe."),
            };
            return toToolResult(value);
        }
        const result = {
            kind: "mutation" as const,
            operation, path, destinationPath, oldVersion,
            newVersion: backend.note?.version, replacements,
            concurrency: vault.concurrency,
            indexFreshness: indexState,
            deepLink: operation === "delete" ? undefined : makeDeepLink(vaultName, destinationPath ?? path),
        };
        if (backend.status === "committed_with_conflict") {
            const value: StructuredNoteResult = {
                schemaVersion, status: "committed_with_conflict", result, effects,
                warning: "The requested mutation committed, but a concurrent CouchDB branch is now present.",
                recovery: recovery("manual_reconcile", "Read the note and reconcile all conflict branches before another mutation."),
            };
            return toToolResult(value);
        }
        const warnings = indexState === "stale" ? ["The vault mutation committed, but index maintenance failed; index-backed results may be stale."] : [];
        const value: StructuredNoteResult = {
            schemaVersion, status: "ok", result, effects, warnings,
            recovery: recovery("none", "No recovery action is required."),
        };
        return toToolResult(value);
    }

    server.addTool = (tool: any) => {
        const original = tool.execute;
        tool.execute = async (args: any, ctx: any) => {
            if (debugLogging) console.log(`[tool] ${tool.name} invoked`);
            const start = performance.now();
            const result = await original(args, ctx);
            if (debugLogging) console.log(`[tool] ${tool.name} → ${((performance.now() - start)).toFixed(0)}ms`);
            return result;
        };
        return _addTool(tool);
    };
    server.addTool({
        name: "read_note",
        description: "Read canonical Markdown and an authoritative opaque version. Use that version for edit, delete, or move.",
        annotations: { title: "Read note", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        }),
        outputSchema: structuredNoteOutputSchema,
        execute: async ({ path }) => {
            const read = await vault.readVersioned(path);
            if (read.status !== "ok") return toToolResult(publicError(read.code));
            let markdown: string;
            try { markdown = markdownDecoder.decode(read.note.bytes); }
            catch { return toToolResult(publicError("INTERNAL_ERROR")); }
            const metadata = parseFrontmatterAndLinks(markdown);
            const value: StructuredNoteResult = {
                schemaVersion, status: "ok",
                result: {
                    kind: "note", path: read.note.path, markdown, version: read.note.version,
                    size: read.note.size,
                    timestamps: { created: new Date(read.note.ctime).toISOString(), modified: new Date(read.note.mtime).toISOString() },
                    frontmatter: metadata.frontmatter, tags: metadata.tags, outgoingLinks: metadata.links,
                    conflict: { hasConflicts: read.note.conflicts.length > 0, leafCount: read.note.conflicts.length + 1 },
                    concurrency: read.note.concurrency, deepLink: makeDeepLink(vaultName, read.note.path),
                },
                effects: [], warnings: [], recovery: recovery("none", "No recovery action is required."),
            };
            return toToolResult(value);
        },
    });

    if (!readOnly) server.addTool({
        name: "create_note",
        description: "Create a new Markdown note only if the path is absent. It never overwrites or resurrects a deleted note." + writeScopeNote,
        annotations: { title: "Create note", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        parameters: z.object({
            path: z.string().describe("New vault-relative .md path"),
            content: z.string().describe("Exact Markdown content; no newline is added or changed"),
        }),
        outputSchema: structuredNoteOutputSchema,
        execute: async ({ path, content }) => {
            if (!isPathWritable(path, writeFolders)) return toToolResult(publicError("WRITE_DENIED"));
            const backend = await vault.createVersioned(path, new TextEncoder().encode(content));
            return finishMutation("create", path, undefined, undefined, content, 0, backend);
        },
    });

    server.addTool({
        name: "list_notes",
        annotations: { title: "List notes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: "List markdown notes in the vault with modification timestamps. Examples: list_notes(sort_by='modified', limit=10) for 10 most recent notes. list_notes(name='meeting') to find notes by name. list_notes(folder='daily') for a specific folder. list_notes(tag='project') for notes with a specific tag. Returns up to 100 notes by default.",
        parameters: z.object({
            folder: z
                .string()
                .optional()
                .describe("Folder to filter by, e.g. 'daily' or 'projects'. Omit for all notes."),
            name: z
                .string()
                .optional()
                .describe("Filter by name (case-insensitive substring match on path), e.g. 'meeting' or 'project-x'."),
            tag: z
                .string()
                .optional()
                .describe("Filter by tag, e.g. 'project' or 'daily'. Use list_tags to discover available tags."),
            sort_by: z
                .enum(["name", "modified"])
                .optional()
                .describe("Sort order: 'name' (default) or 'modified' (most recent first)."),
            modified_after: z
                .string()
                .optional()
                .describe("Only include notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            limit: z.coerce
                .number()
                .optional()
                .describe("Max number of notes to return. Default 100."),
        }),
        execute: async ({ folder, name, tag, sort_by, modified_after, limit }) => {
            // Use search index (works with encrypted vaults), fall back to vault
            let notes = searchIndex.listWithMtime(folder);
            if (notes.length === 0) {
                notes = await vault.listNotesWithMtime(folder);
            }
            if (name) {
                const lower = name.toLowerCase();
                notes = notes.filter((n) => n.path.toLowerCase().includes(lower));
            }
            if (tag) {
                notes = notes.filter((n) => searchIndex.getTags(n.path).includes(tag));
            }
            if (modified_after) {
                const cutoff = new Date(modified_after).getTime();
                if (isNaN(cutoff)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                notes = notes.filter((n) => n.mtime >= cutoff);
            }
            if (notes.length === 0) {
                const empty = searchIndex.status.state === "ready"
                    ? (folder ? `No notes found in folder: ${folder}` : "Vault is empty.")
                    : (folder ? `No indexed notes found in folder: ${folder}` : "No indexed notes are available yet.");
                return withIndexStatusNotice(empty, searchIndex);
            }
            if (sort_by === "modified") {
                notes.sort((a, b) => b.mtime - a.mtime);
            }
            const cap = limit ?? 100;
            const total = notes.length;
            const capped = notes.slice(0, cap);
            const lines = capped.map((n) => {
                const deepLink = makeDeepLink(vaultName, n.path);
                const date = n.mtime ? new Date(n.mtime).toISOString().slice(0, 16) : "";
                return `- ${date} [${n.path}](${deepLink})`;
            });
            if (total > cap) {
                lines.push(`\n... and ${total - cap} more. Use a folder filter or limit to narrow results.`);
            }
            return withIndexStatusNotice(lines.join("\n"), searchIndex);
        },
    });

    if (searchIndex.fullTextEnabled) server.addTool({
        name: "search_notes",
        annotations: { title: "Search notes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            "Search note titles, aliases, headings, tags, and body text using the disk-backed full-text index. Returns ranked paths with matching snippets. Exact title, alias, filename, and path matches rank first, so a known note name is a good query. Use list_notes only to browse a folder or tag without a text query.",
        parameters: z.object({
            query: z
                .string()
                .describe("Words or phrase to find in note content and metadata."),
            folder: z
                .string()
                .optional()
                .describe("Restrict results to this vault-relative folder."),
            tag: z
                .string()
                .optional()
                .describe("Require this exact tag in addition to the text query."),
            modified_after: z
                .string()
                .optional()
                .describe("Only include notes modified after this ISO date."),
            mode: z
                .enum(["all", "any", "phrase"])
                .optional()
                .describe("Match all words (default), any word, or the exact token phrase."),
            limit: z.coerce
                .number()
                .int()
                .min(1)
                .max(50)
                .optional()
                .describe("Maximum ranked results. Default 10; maximum 50."),
        }),
        execute: async ({ query, folder, tag, modified_after, mode, limit }) => {
            let modifiedAfter: number | undefined;
            if (modified_after) {
                modifiedAfter = new Date(modified_after).getTime();
                if (isNaN(modifiedAfter)) {
                    return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                }
            }

            try {
                const status = searchIndex.status;
                const statusNotice = formatIndexStatusNotice(status);
                const results = searchIndex.searchNotes({
                    query,
                    folder,
                    tag,
                    modifiedAfter,
                    mode,
                    limit,
                });
                if (results.length === 0) {
                    return `${statusNotice ? `${statusNotice}\n\n` : ""}No notes found matching: ${query}`;
                }

                const rendered = results.map((result) => {
                    const deepLink = makeDeepLink(vaultName, result.path);
                    const date = result.mtime
                        ? ` (${new Date(result.mtime).toISOString().slice(0, 10)})`
                        : "";
                    const location = result.breadcrumb ? ` — ${result.breadcrumb}` : "";
                    const snippet = result.snippet ? `\n  ${result.snippet}` : "";
                    return `- [${result.path}](${deepLink})${date}${location}${snippet}`;
                }).join("\n");
                return statusNotice ? `${statusNotice}\n\n${rendered}` : rendered;
            } catch (error) {
                return `Invalid search query: ${(error as Error).message}`;
            }
        },
    });

    server.addTool({
        name: "list_folders",
        annotations: { title: "List folders", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            "List all folders in the vault. Use this to discover folder names before writing or listing notes. Returns the folder tree with note counts.",
        parameters: z.object({}),
        execute: async () => {
            let paths = searchIndex.listPaths();
            if (paths.length === 0) {
                paths = await vault.listNotes();
            }
            const folders = new Map<string, number>();
            for (const p of paths) {
                const lastSlash = p.lastIndexOf("/");
                if (lastSlash === -1) {
                    folders.set("(root)", (folders.get("(root)") ?? 0) + 1);
                } else {
                    const folder = p.slice(0, lastSlash);
                    folders.set(folder, (folders.get(folder) ?? 0) + 1);
                    // Ensure all parent folders appear in the list
                    let parent = folder;
                    while (parent.includes("/")) {
                        parent = parent.slice(0, parent.lastIndexOf("/"));
                        if (!folders.has(parent)) folders.set(parent, 0);
                    }
                }
            }
            if (folders.size === 0) {
                const empty = searchIndex.status.state === "ready"
                    ? "Vault is empty."
                    : "No indexed folders are available yet.";
                return withIndexStatusNotice(empty, searchIndex);
            }
            const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return withIndexStatusNotice(
                sorted.map(([f, count]) => `- ${f} (${count} notes)`).join("\n"),
                searchIndex,
            );
        },
    });

    server.addTool({
        name: "list_tags",
        annotations: { title: "List tags", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            "List all tags used in the vault, sorted by frequency. Use this to discover tags before filtering with list_notes.",
        parameters: z.object({}),
        execute: async () => {
            const tags = searchIndex.listAllTags();
            if (tags.length === 0) {
                const empty = searchIndex.status.state === "ready"
                    ? "No tags found in the vault."
                    : "No indexed tags are available yet.";
                return withIndexStatusNotice(empty, searchIndex);
            }
            return withIndexStatusNotice(
                tags.map(({ tag, count }) => `- #${tag} (${count} notes)`).join("\n"),
                searchIndex,
            );
        },
    });



    if (!readOnly) server.addTool({
        name: "edit_note",
        description: "Edit a note using an authoritative version. Operations preserve bytes exactly: replace_all, append, prepend_body, or exactly-one literal replace_once." + writeScopeNote,
        annotations: { title: "Edit note", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-25.md'"),
            version: z.string().describe("Fresh opaque version from read_note or get_note_metadata"),
            content: z.string().describe("Exact replacement or inserted Markdown; no newline is added or changed"),
            operation: z.enum(["replace_all", "append", "prepend_body", "replace_once"]),
            old_text: z.string().optional().describe("Literal required by replace_once; it must occur exactly once"),
        }),
        outputSchema: structuredNoteOutputSchema,
        execute: async ({ path, version, content, operation, old_text }) => {
            if (!isPathWritable(path, writeFolders)) return toToolResult(publicError("WRITE_DENIED"));
            const read = await vault.readVersioned(path);
            if (read.status !== "ok") return toToolResult(publicError(read.code));
            if (read.note.version !== version) {
                const backend: BackendMutationResult = { status: "conflict", code: "STALE_VERSION", effects: [{ kind: "note_updated", path, completed: false }] };
                return finishMutation("edit", path, undefined, version, undefined, undefined, backend);
            }
            let existing: string;
            try { existing = markdownDecoder.decode(read.note.bytes); }
            catch { return toToolResult(publicError("INTERNAL_ERROR")); }
            const edit = applyNoteEdit(existing, operation, content, old_text);
            if (!edit.ok) return toToolResult(publicError(edit.code));
            const backend = await vault.replaceVersioned(path, version, new TextEncoder().encode(edit.content));
            return finishMutation("edit", path, undefined, version, edit.content, edit.replacements, backend);
        },
    });

    if (!readOnly) server.addTool({
        name: "delete_note",
        description: "Delete a note only if its authoritative version is still current. CouchDB deletion is logical." + writeScopeNote,
        annotations: { title: "Delete note", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note to delete"),
            version: z.string().describe("Fresh opaque version from read_note or get_note_metadata"),
        }),
        outputSchema: structuredNoteOutputSchema,
        execute: async ({ path, version }) => {
            if (!isPathWritable(path, writeFolders)) return toToolResult(publicError("WRITE_DENIED"));
            return finishMutation("delete", path, undefined, version, undefined, undefined, await vault.deleteVersioned(path, version));
        },
    });

    if (!readOnly) server.addTool({
        name: "move_note",
        description: "Move a note with an authoritative source version and strict absent destination. The destination is created before conditional source deletion, so partial outcomes are explicit." + writeScopeNote,
        annotations: { title: "Move note", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
            version: z.string().describe("Fresh opaque source version from read_note or get_note_metadata"),
        }),
        outputSchema: structuredNoteOutputSchema,
        execute: async ({ from, to, version }) => {
            if (!isPathWritable(from, writeFolders) || !isPathWritable(to, writeFolders)) return toToolResult(publicError("WRITE_DENIED"));
            const read = await vault.readVersioned(from);
            let content: string | undefined;
            if (read.status === "ok") {
                try { content = markdownDecoder.decode(read.note.bytes); } catch {}
            }
            const backend = await vault.moveVersioned(from, to, version);
            return finishMutation("move", from, to, version, content, undefined, backend);
        },
    });

    server.addTool({
        name: "get_note_metadata",
        description: "Get note metadata and an authoritative opaque version without returning Markdown content. Backlinks include explicit index freshness.",
        annotations: { title: "Get note metadata", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
        }),
        outputSchema: structuredNoteOutputSchema,
        execute: async ({ path }) => {
            const read = await vault.readVersioned(path);
            if (read.status !== "ok") return toToolResult(publicError(read.code));
            let markdown: string;
            try { markdown = markdownDecoder.decode(read.note.bytes); }
            catch { return toToolResult(publicError("INTERNAL_ERROR")); }
            const metadata = parseFrontmatterAndLinks(markdown);
            const value: StructuredNoteResult = {
                schemaVersion, status: "ok",
                result: {
                    kind: "note", path: read.note.path, version: read.note.version, size: read.note.size,
                    timestamps: { created: new Date(read.note.ctime).toISOString(), modified: new Date(read.note.mtime).toISOString() },
                    frontmatter: metadata.frontmatter, tags: metadata.tags, outgoingLinks: metadata.links,
                    backlinks: searchIndex.getBacklinks(path), indexFreshness: indexFreshness(searchIndex),
                    conflict: { hasConflicts: read.note.conflicts.length > 0, leafCount: read.note.conflicts.length + 1 },
                    concurrency: read.note.concurrency, deepLink: makeDeepLink(vaultName, read.note.path),
                },
                effects: [], warnings: [], recovery: recovery("none", "No recovery action is required."),
            };
            return toToolResult(value);
        },
    });
}
