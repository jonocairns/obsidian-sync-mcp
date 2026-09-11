/**
 * Vault access layer — wraps DirectFileManipulator from livesync-commonlib.
 */

import { UpstreamAdapter as DirectFileManipulator } from "./commonlib-adapter.js";
import type { DirectFileManipulatorOptions } from "@vrtmrz/livesync-commonlib";
import { createTextBlob } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { decodeNoteBytes } from "./note-content.js";
import type { FilePathWithPrefix } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { isPathProbablyObfuscated, decrypt } from "octagonal-wheels/encryption/encryption";
import { clearHandlers } from "@vrtmrz/livesync-commonlib/compat/replication/SyncParamsHandler";
import { parseFrontmatterAndLinks } from "./parse.js";
import type { VaultBackend, NoteInfo, NoteListing, BackendMutationResult, BackendReadResult, VersionedNote } from "./vault-backend.js";
import { deriveContent } from "./index-sync.js";
import { classifyIds, type IdFormat } from "./id-format.js";
import { encodeNoteVersion } from "./note-version.js";
import { watchInOrder } from "./ordered-change-feed.js";

type NoteChangeCallback = (path: string, content: string | null, mtime?: number, seq?: string | number) => void;
type CouchChange = { id: string; seq: string | number; deleted?: boolean; doc?: any };
// Mango's $ne does not match missing fields. A bare tombstone has no `type`.
const FILE_CHANGES_SELECTOR = { $or: [{ type: { $ne: "leaf" } }, { _deleted: true }] };

export interface VaultConfig {
    couchdbUrl: string;
    couchdbUser: string;
    couchdbPassword: string;
    database: string;
    passphrase?: string;
    obfuscatePaths?: boolean;
}

export class Vault implements VaultBackend {
    readonly concurrency = "strict_winner_cas" as const;
    private manipulator: DirectFileManipulator;
    private passphrase: string | undefined;
    private config: VaultConfig;
    // Rehydrated from persisted index paths at startup. Retain mappings after
    // deletion too: a failed index transaction must be able to replay removals.
    private indexedPathsById = new Map<string, Set<string>>();
    private stopWatching?: () => Promise<void>;

    constructor(config: VaultConfig) {
        this.config = config;
        this.passphrase = config.passphrase;
        this.manipulator = new DirectFileManipulator(Vault.buildOptions(config, !!config.obfuscatePaths));
    }

    private static buildOptions(config: VaultConfig, obfuscatePaths: boolean): DirectFileManipulatorOptions {
        return {
            url: config.couchdbUrl,
            username: config.couchdbUser,
            password: config.couchdbPassword,
            database: config.database,
            passphrase: config.passphrase,
            obfuscatePassphrase: obfuscatePaths ? config.passphrase : undefined,
            useEden: false,
            enableCompression: false,
            handleFilenameCaseSensitive: false,
            doNotUseFixedRevisionForChunks: false,
        };
    }

    async init(): Promise<void> {
        await this.manipulator.ready.promise;
        await this.reconcileObfuscation();
    }

    /**
     * Detect whether the vault's document IDs are obfuscated and, if the
     * configured COUCHDB_OBFUSCATE_PROPERTIES doesn't match, correct it.
     * A mismatched setting can never work: path→id resolution misses every
     * existing note on read, and writes produce docs LiveSync clients ignore
     * (issues #4, #10). The database is the ground truth.
     */
    private async reconcileObfuscation(): Promise<void> {
        const configured = !!this.config.obfuscatePaths;
        const format = await this.detectIdFormat();
        if (format === "empty") return;
        if (format === "mixed") {
            console.warn(
                "Warning: vault contains both obfuscated and plaintext document IDs. " +
                `Keeping COUCHDB_OBFUSCATE_PROPERTIES=${configured}. ` +
                "This usually means \"Obfuscate properties\" was toggled without rebuilding the database — consider rebuilding it from LiveSync.",
            );
            return;
        }
        const actual = format === "obfuscated";
        if (actual === configured) return;
        if (actual && !this.passphrase) {
            throw new Error(
                "Vault uses obfuscated document IDs (LiveSync \"Obfuscate properties\"), which requires the E2E passphrase. " +
                "Set COUCHDB_PASSPHRASE and COUCHDB_OBFUSCATE_PROPERTIES=true.",
            );
        }
        console.warn(
            actual
                ? "Warning: vault uses obfuscated document IDs but COUCHDB_OBFUSCATE_PROPERTIES is not set to true. " +
                  "Enabling path obfuscation automatically — set COUCHDB_OBFUSCATE_PROPERTIES=true to silence this warning."
                : "Warning: COUCHDB_OBFUSCATE_PROPERTIES=true but vault uses plaintext document IDs. " +
                  "Disabling path obfuscation automatically — set COUCHDB_OBFUSCATE_PROPERTIES=false to silence this warning.",
        );
        await this.manipulator.close();
        this.manipulator = new DirectFileManipulator(Vault.buildOptions(this.config, actual));
        await this.manipulator.ready.promise;
    }

    /** Sample file-entry docs from the changes feed and classify their IDs. */
    private async detectIdFormat(): Promise<IdFormat> {
        const SAMPLE_TARGET = 20;
        const BATCH_SIZE = 100;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        const ids: string[] = [];
        let since: string | number = 0;

        while (ids.length < SAMPLE_TARGET) {
            // Annotate the paginated sequence to avoid circular inference through `since`.
            const result: { results: Array<{ id: string }>; last_seq: string | number } = await db.changes({
                since,
                limit: BATCH_SIZE,
                // Only real file entries — excludes chunks, versioninfo, milestones, sync params.
                selector: { type: { $in: ["plain", "newnote", "notes"] } },
                live: false,
            });
            for (const change of result.results) {
                if (ids.length >= SAMPLE_TARGET) break;
                ids.push(change.id);
            }
            if (result.results.length < BATCH_SIZE) break;
            since = result.last_seq;
        }
        return classifyIds(ids);
    }

    async close(): Promise<void> {
        await this.stopWatching?.();
        this.stopWatching = undefined;
        this.manipulator.endWatch();
        await this.manipulator.close();
    }

    private rememberPath(id: string, path: string): void {
        const paths = this.indexedPathsById.get(id) ?? new Set<string>();
        paths.add(path);
        this.indexedPathsById.set(id, paths);
    }

    private async processChange(change: CouchChange, callback: NoteChangeCallback, indexedPaths?: () => readonly string[]): Promise<void> {
        const meta = change.doc;
        const id = change.id;
        if (id.startsWith("h:") || id.startsWith("_")) return;
        let path = meta?.path ?? "";
        if (isPathProbablyObfuscated(path) && this.passphrase) {
            path = await decrypt(path, this.passphrase, false);
        }
        if (change.deleted || meta?._deleted || meta?.deleted) {
            if (path.endsWith(".md")) this.rememberPath(id, path);
            // Tool mutations can populate the index before the live feed sees
            // their create event. Consult current index paths for an unknown ID.
            if (!this.indexedPathsById.has(id) && indexedPaths) {
                for (const candidate of indexedPaths()) {
                    this.rememberPath(await this.manipulator.path2id(candidate as FilePathWithPrefix), candidate);
                }
            }
            // A metadata-free obfuscated ID cannot be reversed. Unknown IDs
            // have no indexed entry: persisted index paths seed this map.
            const knownPaths = [...(this.indexedPathsById.get(id) ?? [])];
            for (const [index, knownPath] of knownPaths.entries()) {
                // All case aliases must be removed before committing this seq.
                callback(knownPath, null, undefined, index === knownPaths.length - 1 ? change.seq : undefined);
            }
            return;
        }
        if (!meta || !path.endsWith(".md")) return;
        if (meta.type && !["plain", "newnote", "notes"].includes(meta.type)) return;
        // Do not checkpoint past a failed decode/chunk load. Catch-up rolls
        // back and the live feed retries this sequence before handling later ones.
        const doc = await this.manipulator.getByMeta({ ...meta, path });
        const content = deriveContent(doc);
        callback(path, content, content === null ? undefined : doc.mtime, change.seq);
        this.rememberPath(id, path);
    }

    async catchUp(
        since: string,
        callback: (path: string, content: string | null, mtime?: number) => void,
        onBatch?: (since: string, processed: number) => Promise<void>,
        indexedPaths?: readonly string[],
    ): Promise<string> {
        if (indexedPaths) {
            this.indexedPathsById.clear();
            for (const path of indexedPaths) {
                this.rememberPath(await this.manipulator.path2id(path as FilePathWithPrefix), path);
            }
        }
        // Paginate _changes in batches to limit memory usage.
        const BATCH_SIZE = 50;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        let currentSince = since;
        let totalProcessed = 0;

        while (true) {
            const result = await db.changes({
                include_docs: true,
                since: currentSince,
                selector: FILE_CHANGES_SELECTOR,
                live: false,
                limit: BATCH_SIZE,
            });

            for (const change of result.results) {
                await this.processChange(change, callback);
            }

            totalProcessed += result.results.length;
            currentSince = String(result.last_seq);

            // Release chunk cache between batches to prevent memory growth
            this.manipulator.liveSyncLocalDB.clearCaches();

            // Save checkpoint after each batch so crashes don't restart from zero
            if (onBatch && result.results.length > 0) {
                await onBatch(currentSince, totalProcessed);
            }

            // No more changes
            if (result.results.length < BATCH_SIZE) break;
        }

        this.manipulator.since = currentSince;
        return currentSince;
    }

    watchChanges(callback: NoteChangeCallback, indexedPaths?: () => readonly string[]): void {
        if (this.stopWatching) return;
        // Native beginWatch drops legacy entries and metadata-free tombstones.
        // Consume the raw feed in order using the same decoder as catch-up.
        this.stopWatching = watchInOrder<CouchChange>({
            since: this.manipulator.since || "0",
            open: (since) => this.manipulator.liveSyncLocalDB.localDatabase.changes({
                include_docs: true, since, selector: FILE_CHANGES_SELECTOR, live: true,
            }),
            handle: async (change) => {
                await this.processChange(change, callback, indexedPaths);
                this.manipulator.since = String(change.seq);
            },
        });
    }

    private validatePath(path: string): void {
        const segments = path.split("/");
        if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.length > 1000 || !path.endsWith(".md") ||
            segments.some((part) => !part || part === "." || part === "..")) {
            throw Object.assign(new Error("Invalid path"), { code: "INVALID_PATH" });
        }
    }

    private async tombstoneExists(path: string): Promise<boolean> {
        const id = await this.manipulator.path2id(path as FilePathWithPrefix);
        const row = (await this.manipulator.liveSyncLocalDB.localDatabase.allDocs({ keys: [id] })).rows[0] as any;
        return Boolean(row?.value?.deleted);
    }

    private backendIdentity(): string {
        const url = new URL(this.config.couchdbUrl);
        url.username = "";
        url.password = "";
        url.hash = "";
        return "couchdb:" + url.toString().replace(/\/$/, "") +
            "/" + encodeURIComponent(this.config.database);
    }

    async readVersioned(path: string): Promise<BackendReadResult> {
        try {
            this.validatePath(path);
            const entry = await this.manipulator.getVersionedEntry(path as FilePathWithPrefix);
            if (!entry) return { status: "error", code: await this.tombstoneExists(path) ? "RESTORE_REQUIRED" : "NOTE_NOT_FOUND" };
            if (entry.deleted || entry._deleted) return { status: "error", code: "RESTORE_REQUIRED" };
            // Only live sibling leaves require content reconciliation. CouchDB's
            // deleted sibling leaves are revision history: LiveSync deliberately
            // excludes them from its conflict inspector and resolver. Keep both
            // kinds in the opaque version state below so any leaf-tree change
            // still invalidates a stale mutation token.
            const conflicts = [...(entry._conflicts ?? [])].sort();
            const leaves = [
                { revision: entry._rev, deleted: false },
                ...(entry._conflicts ?? []).map((revision: string) => ({ revision, deleted: false })),
                ...(entry._deleted_conflicts ?? []).map((revision: string) => ({ revision, deleted: true })),
            ].sort((a, b) => a.revision.localeCompare(b.revision));
            const bytes = decodeNoteBytes(entry);
            const note: VersionedNote = {
                path,
                bytes,
                version: encodeNoteVersion({
                    backend: this.backendIdentity(),
                    path,
                    state: "exists",
                    mutation: { winner: entry._rev, leaves },
                }),
                size: entry.size ?? bytes.byteLength,
                ctime: entry.ctime ?? 0,
                mtime: entry.mtime ?? 0,
                conflicts,
                concurrency: this.concurrency,
                backendState: { winnerRevision: entry._rev },
            };
            return { status: "ok", note };
        } catch (error: any) {
            if (error.code === "INVALID_PATH") return { status: "error", code: "INVALID_PATH" };
            if (error.status === 404 || error.name === "not_found") {
                try { return { status: "error", code: await this.tombstoneExists(path) ? "RESTORE_REQUIRED" : "NOTE_NOT_FOUND" }; }
                catch { return { status: "error", code: "BACKEND_UNAVAILABLE" }; }
            }
            return { status: "error", code: "BACKEND_UNAVAILABLE" };
        }
    }

    async readNote(path: string): Promise<string | null> {
        const result = await this.readVersioned(path);
        return result.status === "ok" ? new TextDecoder().decode(result.note.bytes) : null;
    }

    private isConflictError(error: any): boolean {
        return error?.status === 409 || error?.name === "conflict";
    }

    private winnerRevision(note: VersionedNote): string {
        return (note.backendState as { winnerRevision: string }).winnerRevision;
    }

    private async guardedPut(path: string, bytes: Uint8Array, ctime: number, expectedRevision?: string): Promise<BackendMutationResult> {
        const effect = { kind: expectedRevision ? "note_updated" as const : "note_created" as const, path, completed: false };
        try {
            clearHandlers();
            // LiveSync derives the encoding from the Blob MIME type, not the
            // "plain" argument. Binary chunks in a .md file fail its client size check.
            const committed = await this.manipulator.put(
                path,
                new Blob([Uint8Array.from(bytes)], { type: "text/plain" }),
                { ctime, mtime: Date.now(), size: bytes.byteLength },
                "plain",
                expectedRevision,
                true,
            );
            if (!committed) return { status: "error", code: "BACKEND_UNAVAILABLE", effects: [effect] };
            effect.completed = true;
            const after = await this.readVersioned(path);
            if (after.status !== "ok") return { status: "indeterminate", effects: [effect] };
            if (after.note.conflicts.length > 0) return { status: "committed_with_conflict", note: after.note, effects: [effect] };
            return { status: "ok", note: after.note, effects: [effect] };
        } catch (error: any) {
            if (this.isConflictError(error)) return { status: "conflict", code: expectedRevision ? "STALE_VERSION" : "DESTINATION_EXISTS", effects: [effect] };
            return { status: "indeterminate", effects: [effect] };
        }
    }

    async createVersioned(path: string, bytes: Uint8Array): Promise<BackendMutationResult> {
        try { this.validatePath(path); } catch { return { status: "error", code: "INVALID_PATH", effects: [] }; }
        const existing = await this.readVersioned(path);
        if (existing.status === "ok") return { status: "conflict", code: "DESTINATION_EXISTS", effects: [] };
        if (existing.code === "RESTORE_REQUIRED") return { status: "error", code: "RESTORE_REQUIRED", effects: [] };
        if (existing.code !== "NOTE_NOT_FOUND") return { status: "error", code: existing.code, effects: [] };
        return this.guardedPut(path, bytes, Date.now());
    }

    async replaceVersioned(path: string, expectedVersion: string, bytes: Uint8Array): Promise<BackendMutationResult> {
        const current = await this.readVersioned(path);
        if (current.status !== "ok") return { status: "error", code: current.code, effects: [] };
        const effect = { kind: "note_updated" as const, path, completed: false };
        if (current.note.conflicts.length > 0) return { status: "conflict", code: "PRE_EXISTING_CONFLICT", effects: [effect] };
        if (current.note.version !== expectedVersion) return { status: "conflict", code: "STALE_VERSION", effects: [effect] };
        return this.guardedPut(path, bytes, current.note.ctime, this.winnerRevision(current.note));
    }

    async deleteVersioned(path: string, expectedVersion: string): Promise<BackendMutationResult> {
        const current = await this.readVersioned(path);
        const effect = { kind: "note_deleted" as const, path, completed: false };
        if (current.status !== "ok") return { status: "error", code: current.code, effects: [effect] };
        if (current.note.conflicts.length > 0) return { status: "conflict", code: "PRE_EXISTING_CONFLICT", effects: [effect] };
        if (current.note.version !== expectedVersion) return { status: "conflict", code: "STALE_VERSION", effects: [effect] };
        try {
            clearHandlers();
            const response = await this.manipulator.strictDelete(path as FilePathWithPrefix, this.winnerRevision(current.note));
            if (!response) return { status: "error", code: "BACKEND_UNAVAILABLE", effects: [effect] };
            effect.completed = true;
            try {
                const id = await this.manipulator.path2id(path as FilePathWithPrefix);
                const post = await this.manipulator.readRevisionMetadata(id);
                if ((post._conflicts ?? []).length > 0) return { status: "committed_with_conflict", effects: [effect] };
            } catch {
                return { status: "indeterminate", effects: [effect] };
            }
            return { status: "ok", effects: [effect] };
        } catch (error: any) {
            if (this.isConflictError(error)) return { status: "conflict", code: "STALE_VERSION", effects: [effect] };
            return { status: "indeterminate", effects: [effect] };
        }
    }

    async moveVersioned(from: string, to: string, expectedVersion: string): Promise<BackendMutationResult> {
        try { this.validatePath(from); this.validatePath(to); }
        catch { return { status: "error", code: "INVALID_PATH", effects: [] }; }
        const effects = [
            { kind: "destination_created" as const, path: to, completed: false },
            { kind: "source_deleted" as const, path: from, completed: false },
        ];
        const source = await this.readVersioned(from);
        if (source.status !== "ok") return { status: "error", code: source.code, effects };
        if (source.note.conflicts.length > 0) return { status: "conflict", code: "PRE_EXISTING_CONFLICT", effects };
        if (source.note.version !== expectedVersion) return { status: "conflict", code: "STALE_VERSION", effects };
        const destination = await this.readVersioned(to);
        if (destination.status === "ok") return { status: "conflict", code: "DESTINATION_EXISTS", effects };
        if (destination.code === "RESTORE_REQUIRED") return { status: "error", code: "RESTORE_REQUIRED", effects };
        if (destination.code !== "NOTE_NOT_FOUND") return { status: "error", code: destination.code, effects };
        const created = await this.guardedPut(to, source.note.bytes, source.note.ctime);
        effects[0].completed = created.effects.some((effect) => effect.completed);
        if (created.status !== "ok" && created.status !== "committed_with_conflict") return { ...created, effects };
        effects[0].completed = true;
        const deleted = await this.deleteVersioned(from, expectedVersion);
        if (deleted.status !== "ok" && deleted.status !== "committed_with_conflict") {
            if (deleted.status === "indeterminate") return { status: "indeterminate", effects };
            return { status: "partial", code: "code" in deleted ? deleted.code : "BACKEND_UNAVAILABLE", effects };
        }
        effects[1].completed = true;
        if (created.status === "committed_with_conflict" || deleted.status === "committed_with_conflict") {
            return { status: "committed_with_conflict", note: created.note, effects };
        }
        return { status: "ok", note: created.note, effects };
    }

    async writeNote(path: string, content: string): Promise<boolean> {
        this.validatePath(path);
        // Clear cached PBKDF2 salt so we re-fetch from CouchDB before encrypting.
        // Prevents stale salt after Obsidian "Overwrite remote" rebuilds (issue #686).
        clearHandlers();

        // Preserve ctime if note already exists
        let ctime = Date.now();
        const existing = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (existing && "ctime" in existing) {
            ctime = existing.ctime;
        }

        const blob = createTextBlob(content);
        return await this.manipulator.put(path, blob, {
            ctime,
            mtime: Date.now(),
            size: new TextEncoder().encode(content).byteLength,
        });
    }

    async deleteNote(path: string): Promise<boolean> {
        this.validatePath(path);
        clearHandlers();
        return await this.manipulator.delete(path);
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        this.validatePath(from);
        this.validatePath(to);
        const content = await this.readNote(from);
        if (content === null) return false;
        const wrote = await this.writeNote(to, content);
        if (!wrote) return false;
        return await this.deleteNote(from);
    }

    async getMetadata(path: string): Promise<NoteInfo | null> {
        this.validatePath(path);
        const read = await this.readVersioned(path);
        if (read.status !== "ok") return null;
        const content = new TextDecoder().decode(read.note.bytes);
        return {
            path,
            size: read.note.size,
            ctime: read.note.ctime,
            mtime: read.note.mtime,
            ...parseFrontmatterAndLinks(content),
        };
    }

    async listNotes(folder?: string): Promise<string[]> {
        const notes = await this.listNotesWithMtime(folder);
        return notes.map((n) => n.path);
    }

    async listNotesWithMtime(folder?: string): Promise<NoteListing[]> {
        if (folder && !folder.endsWith("/")) folder += "/";
        const results: NoteListing[] = [];
        for await (const doc of this.manipulator.enumerateAllNormalDocs({ metaOnly: true })) {
            const entry = doc;
            if (entry.deleted) continue;
            const notePath = entry.path ?? "";
            if (!notePath.endsWith(".md")) continue;
            if (folder && !notePath.startsWith(folder)) continue;
            results.push({ path: notePath, mtime: entry.mtime ?? 0 });
        }
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }

}
