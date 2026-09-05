import type { NoteMetadata } from "./parse.js";

export interface NoteInfo extends NoteMetadata {
    path: string;
    size: number;
    ctime: number;
    mtime: number;
}

export interface NoteListing {
    path: string;
    mtime: number;
}

export type ConcurrencyGuarantee = "best_effort" | "strict_winner_cas";
export interface VersionedNote {
    path: string;
    bytes: Uint8Array;
    version: string;
    size: number;
    ctime: number;
    mtime: number;
    conflicts: string[];
    concurrency: ConcurrencyGuarantee;
    backendState?: unknown;
}
export type BackendFailureCode = "INVALID_PATH" | "NOTE_NOT_FOUND" | "STALE_VERSION" | "PRE_EXISTING_CONFLICT" | "DESTINATION_EXISTS" | "RESTORE_REQUIRED" | "BACKEND_UNAVAILABLE" | "INTERNAL_ERROR";
export type BackendReadResult = { status: "ok"; note: VersionedNote } | { status: "error"; code: BackendFailureCode };
export interface BackendEffect {
    kind: "destination_created" | "source_deleted" | "note_created" | "note_updated" | "note_deleted";
    path: string;
    completed: boolean;
}
export type BackendMutationResult =
    | { status: "ok"; note?: VersionedNote; effects: BackendEffect[] }
    | { status: "conflict"; code: BackendFailureCode; effects: BackendEffect[] }
    | { status: "committed_with_conflict"; note?: VersionedNote; effects: BackendEffect[] }
    | { status: "partial"; code: BackendFailureCode; effects: BackendEffect[] }
    | { status: "indeterminate"; effects: BackendEffect[] }
    | { status: "error"; code: BackendFailureCode; effects: BackendEffect[] };
export interface VersionedNoteBackend {
    readonly concurrency: ConcurrencyGuarantee;
    readVersioned(path: string): Promise<BackendReadResult>;
    createVersioned(path: string, bytes: Uint8Array): Promise<BackendMutationResult>;
    replaceVersioned(path: string, expectedVersion: string, bytes: Uint8Array): Promise<BackendMutationResult>;
    deleteVersioned(path: string, expectedVersion: string): Promise<BackendMutationResult>;
    moveVersioned(from: string, to: string, expectedVersion: string): Promise<BackendMutationResult>;
}

export interface VaultBackend extends VersionedNoteBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    moveNote(from: string, to: string): Promise<boolean>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    watchChanges?(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void): void;
    /** Catch up on changes since a sequence. Returns the new sequence. CouchDB only. */
    catchUp?(since: string, callback: (path: string, content: string | null, mtime?: number) => void, onBatch?: (since: string, processed: number) => Promise<void>): Promise<string>;
}
