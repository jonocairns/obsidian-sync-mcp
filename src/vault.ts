/**
 * Vault access layer — wraps DirectFileManipulator from livesync-commonlib.
 */

import { DirectFileManipulator } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import type { DirectFileManipulatorOptions } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import { createBinaryBlob, createTextBlob } from "../lib/livesync-commonlib/src/common/utils.ts";
import { decodeBinary } from "../lib/livesync-commonlib/src/string_and_binary/convert.ts";
import type { FilePathWithPrefix } from "../lib/livesync-commonlib/src/common/types.ts";
import type { MetaEntry } from "../lib/livesync-commonlib/src/API/DirectFileManipulatorV2.ts";
import { isPathProbablyObfuscated, decrypt } from "octagonal-wheels/encryption/encryption";
import { clearHandlers } from "../lib/livesync-commonlib/src/replication/SyncParamsHandler.ts";
import { parseFrontmatterAndLinks } from "./parse.js";
import type { VaultBackend, NoteInfo, NoteListing, BackendMutationResult, BackendReadResult, VersionedNote } from "./vault-backend.js";
import { deriveContent } from "./index-sync.js";
import { classifyIds, type IdFormat } from "./id-format.js";
import { encodeNoteVersion } from "./note-version.js";

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
            const result = await db.changes({
                since,
                limit: BATCH_SIZE,
                // Only real file entries — excludes chunks, versioninfo, milestones, sync params.
                selector: { type: { $in: ["plain", "newnote"] } },
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
        this.manipulator.endWatch();
        await this.manipulator.close();
    }

    private static mdFilter(meta: any): boolean {
        return (meta.path ?? "").endsWith(".md");
    }

    private static docToChange(doc: any, callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void, seq?: string | number) {
        const path = doc.path ?? "";
        if (!path.endsWith(".md")) return;
        // null => deleted (remove); "" => existing empty note (index it, don't drop)
        const content = deriveContent(doc);
        callback(path, content, content === null ? undefined : doc.mtime, seq);
    }

    async catchUp(
        since: string,
        callback: (path: string, content: string | null, mtime?: number) => void,
        onBatch?: (since: string, processed: number) => Promise<void>,
    ): Promise<string> {
        // Paginate _changes in batches to limit memory usage.
        const BATCH_SIZE = 50;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        let currentSince = since;
        let totalProcessed = 0;

        while (true) {
            const result = await db.changes({
                include_docs: true,
                since: currentSince,
                selector: { type: { $ne: "leaf" } },
                live: false,
                limit: BATCH_SIZE,
            });

            for (const change of result.results) {
                if (!change.doc) continue;
                const meta = change.doc as any;
                // Skip chunks and system docs
                if (meta.type === "leaf" || meta.type === "versioninfo") continue;
                if (meta._id?.startsWith("h:") || meta._id?.startsWith("_")) continue;
                // Decrypt path to check .md BEFORE fetching chunks (avoids loading large attachments)
                let path = meta.path ?? "";
                if (isPathProbablyObfuscated(path) && this.passphrase) {
                    try { path = await decrypt(path, this.passphrase, false); } catch { continue; }
                }
                if (!path.endsWith(".md") && !meta.deleted) continue;
                const doc = await this.manipulator.getByMeta(meta).catch(() => null);
                if (doc) Vault.docToChange(doc, callback);
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

    watchChanges(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void): void {
        // catchUp already set this.manipulator.since to the right point
        this.manipulator.beginWatch(
            (doc, seq) => Vault.docToChange(doc, callback, seq),
            Vault.mdFilter,
        );
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
            const entry = await this.manipulator.liveSyncLocalDB.getDBEntry(
                path as FilePathWithPrefix,
                { conflicts: true, deleted_conflicts: true } as any,
                false,
                true,
                true,
            ) as any;
            if (!entry) return { status: "error", code: await this.tombstoneExists(path) ? "RESTORE_REQUIRED" : "NOTE_NOT_FOUND" };
            if (entry.deleted || entry._deleted) return { status: "error", code: "RESTORE_REQUIRED" };
            const conflicts = [...(entry._conflicts ?? []), ...(entry._deleted_conflicts ?? [])].sort();
            const leaves = [
                { revision: entry._rev, deleted: false },
                ...(entry._conflicts ?? []).map((revision: string) => ({ revision, deleted: false })),
                ...(entry._deleted_conflicts ?? []).map((revision: string) => ({ revision, deleted: true })),
            ].sort((a, b) => a.revision.localeCompare(b.revision));
            const bytes = entry.type === "newnote" || entry.datatype === "newnote"
                ? new Uint8Array(decodeBinary(entry.data))
                : new TextEncoder().encode(Array.isArray(entry.data) ? entry.data.join("") : String(entry.data ?? ""));
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
            const committed = await this.manipulator.put(
                path,
                createBinaryBlob(Uint8Array.from(bytes)),
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
            const response = await this.manipulator.liveSyncLocalDB.storeDeletionAtRevision(
                path as FilePathWithPrefix,
                this.winnerRevision(current.note),
                true,
            );
            if (!response) return { status: "error", code: "BACKEND_UNAVAILABLE", effects: [effect] };
            effect.completed = true;
            try {
                const id = await this.manipulator.path2id(path as FilePathWithPrefix);
                const post = await this.manipulator.liveSyncLocalDB.getRaw(id, { conflicts: true, deleted_conflicts: true } as any) as any;
                const branches = [...(post._conflicts ?? []), ...(post._deleted_conflicts ?? [])];
                if (branches.length > 0) return { status: "committed_with_conflict", effects: [effect] };
            } catch {}
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
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry) return null;
        const content = "data" in entry && Array.isArray(entry.data) ? entry.data.join("") : "";
        return {
            path,
            size: entry.size,
            ctime: entry.ctime,
            mtime: entry.mtime,
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
            const entry = doc as MetaEntry;
            if (entry.deleted) continue;
            const notePath = entry.path ?? "";
            if (!notePath.endsWith(".md")) continue;
            if (folder && !notePath.startsWith(folder)) continue;
            results.push({ path: notePath, mtime: entry.mtime ?? 0 });
        }
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }

}
