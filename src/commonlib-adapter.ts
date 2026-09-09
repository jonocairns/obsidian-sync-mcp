/**
 * Application adapter over unmodified Commonlib 0.1.23.
 * Commonlib owns content encoding, splitting, hashing, chunk storage and encryption.
 * This adapter owns the final metadata commit and revision-consistent conflict reads.
 */
import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import { createBlob, determineTypeFromBlob } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import type {
    DocumentID, EntryLeaf, FilePathWithPrefix, LoadedEntry, NewEntry, PlainEntry, SavingEntry,
} from "@vrtmrz/livesync-commonlib/compat/common/types";

type FileInfo = Parameters<DirectFileManipulator["put"]>[2];
type RevisionMetadata = {
    _rev: string;
    _conflicts?: string[];
    _deleted_conflicts?: string[];
};

export class UpstreamAdapter extends DirectFileManipulator {
    override async put(
        path: string,
        data: string[] | Blob,
        info: FileInfo,
        type: "newnote" | "plain" = "plain",
        expectedRevision?: string,
        strict = false,
    ): Promise<boolean> {
        if (!strict) return super.put(path, data, info, type);
        await this.ready.promise;
        const db = this.liveSyncLocalDB;
        if (!db.isTargetFile(path)) return false;
        const blob = data instanceof Blob ? data : createBlob(data);
        const datatype = determineTypeFromBlob(blob);
        const note: SavingEntry = {
            _id: await this.path2id(path as FilePathWithPrefix), path: path as FilePathWithPrefix,
            data: blob, ...info, type: datatype, datatype, eden: {}, children: [],
        };
        const { splitter, entryManager, chunkManager } = db.managers;
        await splitter.initialised;
        return chunkManager.transaction(async () => {
            const children: DocumentID[] = [];
            let pending: EntryLeaf[] = [];
            let pendingSize = 0;
            const flush = async () => {
                if (pending.length === 0) return true;
                const result = await chunkManager.write(pending, { skipCache: false }, note._id);
                pending = [];
                pendingSize = 0;
                return result.result;
            };
            for await (const piece of await splitter.splitContent(note)) {
                if (piece.length === 0) continue;
                const chunk = await entryManager.prepareChunk(piece);
                children.push(chunk.id);
                pending.push({ _id: chunk.id, type: "leaf", data: piece });
                pendingSize += piece.length;
                if (pendingSize >= 2 * 1024 * 1024 && !(await flush())) return false;
            }
            if (!(await flush())) return false;
            const document: NewEntry | PlainEntry = {
                _id: note._id, path: note.path, ...info, type: datatype, children, eden: {},
                ...(expectedRevision === undefined ? {} : { _rev: expectedRevision }),
            };
            // No force flag and no lookup of a newer revision. CouchDB decides
            // whether this exact base (or create without a base) is still valid.
            return (await db.putRaw(document)).ok;
        });
    }

    async strictDelete(path: FilePathWithPrefix, baseRevision: string) {
        const db = this.liveSyncLocalDB;
        if (!db.isTargetFile(path)) return false;
        const id = await this.path2id(path);
        const original = await db.getRaw(id, { rev: baseRevision });
        if (original.type === "leaf") return false;
        const document = { ...original, deleted: true, mtime: Date.now() };
        delete document._deleted;
        return db.putRaw(document);
    }

    async readRevisionMetadata(id: DocumentID): Promise<RevisionMetadata> {
        // PouchDB 9 drops deleted_conflicts from GET options. Read the complete
        // revision snapshot through CouchDB's HTTP API instead. Content still
        // goes through Commonlib's decoding and encryption machinery below.
        const endpoint = `${this.options.url.replace(/\/+$/, "")}/${encodeURIComponent(this.options.database)}/${encodeURIComponent(id)}`;
        const fetcher = this.runtimeOptions.fetch ?? globalThis.fetch;
        const response = await fetcher(`${endpoint}?conflicts=true&deleted_conflicts=true`, {
            headers: { Authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64")}` },
        });
        if (!response.ok) throw Object.assign(new Error("CouchDB revision lookup failed"), { status: response.status });
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || !("_rev" in value) || typeof value._rev !== "string") {
            throw new Error("Invalid CouchDB revision metadata");
        }
        const revisions = (key: "_conflicts" | "_deleted_conflicts"): string[] => {
            const field: unknown = key === "_conflicts"
                ? ("_conflicts" in value ? value._conflicts : undefined)
                : ("_deleted_conflicts" in value ? value._deleted_conflicts : undefined);
            if (field === undefined) return [];
            if (!Array.isArray(field) || !field.every((rev): rev is string => typeof rev === "string")) {
                throw new Error("Invalid CouchDB conflict metadata");
            }
            return field;
        };
        return { _rev: value._rev, _conflicts: revisions("_conflicts"), _deleted_conflicts: revisions("_deleted_conflicts") };
    }

    async getVersionedEntry(path: FilePathWithPrefix): Promise<false | (LoadedEntry & RevisionMetadata)> {
        const metadata = await this.readRevisionMetadata(await this.path2id(path));
        const entry = await this.liveSyncLocalDB.getDBEntry(path, { rev: metadata._rev }, false, true, true);
        if (!entry) throw new Error("Could not load the pinned CouchDB revision");
        // Pin decoding to the same revision as the conflict snapshot. A later
        // update cannot mix new content with the old revision's version token.
        return { ...entry, ...metadata };
    }
}
