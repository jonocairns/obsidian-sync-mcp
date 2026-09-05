import { readFile, unlink, mkdir, stat, realpath, rename, open } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { realpathSync } from "fs";
import { createHash, randomUUID } from "node:crypto";
import { glob } from "fs/promises";
import { parseFrontmatterAndLinks } from "./parse.js";
import { encodeNoteVersion } from "./note-version.js";
import type { VaultBackend, NoteInfo, NoteListing, BackendMutationResult, BackendReadResult, VersionedNote } from "./vault-backend.js";

export class LocalVault implements VaultBackend {
    private root: string;
    readonly concurrency = "best_effort" as const;
    private writerTails = new Map<string, Promise<void>>();

    constructor(vaultPath: string) {
        this.root = realpathSync(resolve(vaultPath));
    }

    private normalizePath(path: string): string {
        const canonical = path;
        const segments = canonical.split("/");
        if (!canonical || canonical.startsWith("/") || canonical.includes("\\") || canonical.includes("\0") || canonical.length > 1000 ||
            !canonical.endsWith(".md") || segments.some((part) => !part || part === "." || part === "..")) {
            throw Object.assign(new Error("Path traversal blocked"), { code: "INVALID_PATH" });
        }
        return canonical;
    }

    private async safePath(path: string): Promise<string> {
        const canonical = this.normalizePath(path);
        const full = resolve(this.root, canonical);
        if (!full.startsWith(this.root + sep)) {
            throw Object.assign(new Error("Path traversal blocked"), { code: "INVALID_PATH" });
        }
        let candidate = full;
        try {
            const real = await realpath(full);
            if (!real.startsWith(this.root + sep)) {
                throw Object.assign(new Error("Path traversal blocked"), { code: "INVALID_PATH" });
            }
            return real;
        } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
        }
        while (candidate !== this.root) {
            candidate = dirname(candidate);
            try {
                const parent = await realpath(candidate);
                if (parent !== this.root && !parent.startsWith(this.root + sep)) {
                    throw Object.assign(new Error("Path traversal blocked"), { code: "INVALID_PATH" });
                }
                return full;
            } catch (error: any) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        return full;
    }

    private async withLocks<T>(paths: string[], action: () => Promise<T>): Promise<T> {
        const releases: Array<() => void> = [];
        for (const path of [...new Set(paths)].sort()) {
            const previous = this.writerTails.get(path) ?? Promise.resolve();
            let release!: () => void;
            const current = new Promise<void>((resolve) => { release = resolve; });
            const tail = previous.then(() => current);
            this.writerTails.set(path, tail);
            await previous;
            releases.push(() => {
                release();
                if (this.writerTails.get(path) === tail) this.writerTails.delete(path);
            });
        }
        try { return await action(); } finally { for (const release of releases.reverse()) release(); }
    }


    private async safeFolder(path: string): Promise<string> {
        const canonical = path.replace(/\\/g, "/").replace(/\/$/, "");
        const segments = canonical.split("/");
        if (!canonical || canonical.startsWith("/") || canonical.includes("\0") || canonical.length > 1000 ||
            segments.some((part) => !part || part === "." || part === "..")) {
            throw Object.assign(new Error("Path traversal blocked"), { code: "INVALID_PATH" });
        }
        const full = resolve(this.root, canonical);
        if (!full.startsWith(this.root + sep)) throw Object.assign(new Error("Path traversal blocked"), { code: "INVALID_PATH" });
        try {
            const real = await realpath(full);
            if (real !== this.root && !real.startsWith(this.root + sep)) {
                throw Object.assign(new Error("Path traversal blocked"), { code: "INVALID_PATH" });
            }
            return real;
        } catch (error: any) {
            if (error.code === "ENOENT") return full;
            throw error;
        }
    }
    private statIdentity(value: any) {
        return { dev: String(value.dev), ino: String(value.ino), size: String(value.size), mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
    }

    private async snapshot(path: string): Promise<VersionedNote> {
        const canonical = this.normalizePath(path);
        const full = await this.safePath(canonical);
        for (let attempt = 0; attempt < 3; attempt++) {
            const before = await stat(full, { bigint: true });
            const bytes = await readFile(full);
            const after = await stat(full, { bigint: true });
            const beforeId = this.statIdentity(before);
            const afterId = this.statIdentity(after);
            if (JSON.stringify(beforeId) !== JSON.stringify(afterId)) continue;
            const createdNs = after.birthtimeNs > 0n ? after.birthtimeNs : after.ctimeNs;
            return {
                path: canonical,
                bytes,
                version: encodeNoteVersion({ backend: "local:" + this.root, path: canonical, state: "exists", mutation: { ...afterId, contentHash: createHash("sha256").update(bytes).digest("base64url") } }),
                size: Number(after.size),
                ctime: Number(createdNs / 1_000_000n),
                mtime: Number(after.mtimeNs / 1_000_000n),
                conflicts: [],
                concurrency: this.concurrency,
                backendState: { mode: Number(after.mode & 0o777n) },
            };
        }
        throw Object.assign(new Error("Unable to obtain a coherent file snapshot"), { code: "BACKEND_UNAVAILABLE" });
    }

    async readVersioned(path: string): Promise<BackendReadResult> {
        try { return { status: "ok", note: await this.snapshot(path) }; }
        catch (error: any) {
            if (error.code === "ENOENT") return { status: "error", code: "NOTE_NOT_FOUND" };
            if (error.code === "INVALID_PATH") return { status: "error", code: "INVALID_PATH" };
            return { status: "error", code: "BACKEND_UNAVAILABLE" };
        }
    }

    async init(): Promise<void> {}

    async close(): Promise<void> {}

    async readNote(path: string): Promise<string | null> {
        this.normalizePath(path);
        const result = await this.readVersioned(path);
        return result.status === "ok" ? new TextDecoder().decode(result.note.bytes) : null;
    }

    async writeNote(path: string, content: string): Promise<boolean> {
        this.normalizePath(path);
        try {
            const existing = await this.readVersioned(path);
            const bytes = new TextEncoder().encode(content);
            const result = existing.status === "ok"
                ? await this.replaceVersioned(path, existing.note.version, bytes)
                : await this.createVersioned(path, bytes);
            return result.status === "ok";
        } catch {
            return false;
        }
    }

    private async syncDirectory(path: string): Promise<void> {
        const handle = await open(dirname(path), "r");
        try { await handle.sync(); } finally { await handle.close(); }
    }

    private async createVersionedUnlocked(path: string, bytes: Uint8Array, mode = 0o600): Promise<BackendMutationResult> {
        const effect = { kind: "note_created" as const, path, completed: false };
        try {
            const full = await this.safePath(path);
            await mkdir(dirname(full), { recursive: true });
            await this.safePath(path);
            const handle = await open(full, "wx", mode);
            try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
            effect.completed = true;
            await this.syncDirectory(full);
            const read = await this.readVersioned(path);
            return read.status === "ok" ? { status: "ok", note: read.note, effects: [effect] } : { status: "indeterminate", effects: [effect] };
        } catch (error: any) {
            if (error.code === "EEXIST") return { status: "conflict", code: "DESTINATION_EXISTS", effects: [effect] };
            if (effect.completed) return { status: "indeterminate", effects: [effect] };
            return { status: "error", code: error.code === "INVALID_PATH" ? "INVALID_PATH" : "BACKEND_UNAVAILABLE", effects: [effect] };
        }
    }

    async createVersioned(path: string, bytes: Uint8Array): Promise<BackendMutationResult> {
        let canonical: string;
        try { canonical = this.normalizePath(path); } catch { return { status: "error", code: "INVALID_PATH", effects: [] }; }
        return this.withLocks([canonical], () => this.createVersionedUnlocked(canonical, bytes));
    }

    async replaceVersioned(path: string, expectedVersion: string, bytes: Uint8Array): Promise<BackendMutationResult> {
        let canonical: string;
        try { canonical = this.normalizePath(path); } catch { return { status: "error", code: "INVALID_PATH", effects: [] }; }
        return this.withLocks([canonical], async () => {
            const effect = { kind: "note_updated" as const, path: canonical, completed: false };
            let temporary: string | undefined;
            try {
                const initial = await this.readVersioned(canonical);
                if (initial.status !== "ok") return { status: "error", code: initial.code, effects: [effect] };
                if (initial.note.version !== expectedVersion) return { status: "conflict", code: "STALE_VERSION", effects: [effect] };
                const full = await this.safePath(canonical);
                temporary = full + ".tmp-" + randomUUID();
                const mode = (initial.note.backendState as { mode: number }).mode;
                const handle = await open(temporary, "wx", mode);
                try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
                const finalCheck = await this.readVersioned(canonical);
                if (finalCheck.status !== "ok" || finalCheck.note.version !== expectedVersion) {
                    await unlink(temporary).catch(() => {});
                    return { status: "conflict", code: "STALE_VERSION", effects: [effect] };
                }
                await rename(temporary, full);
                temporary = undefined;
                effect.completed = true;
                await this.syncDirectory(full);
                const read = await this.readVersioned(canonical);
                return read.status === "ok" ? { status: "ok", note: read.note, effects: [effect] } : { status: "indeterminate", effects: [effect] };
            } catch (error: any) {
                if (temporary) await unlink(temporary).catch(() => {});
                if (error.code === "ENOENT") return { status: "error", code: "NOTE_NOT_FOUND", effects: [effect] };
                return effect.completed ? { status: "indeterminate", effects: [effect] } : { status: "error", code: "BACKEND_UNAVAILABLE", effects: [effect] };
            }
        });
    }

    async deleteVersioned(path: string, expectedVersion: string): Promise<BackendMutationResult> {
        let canonical: string;
        try { canonical = this.normalizePath(path); } catch { return { status: "error", code: "INVALID_PATH", effects: [] }; }
        return this.withLocks([canonical], async () => {
            const effect = { kind: "note_deleted" as const, path: canonical, completed: false };
            const current = await this.readVersioned(canonical);
            if (current.status !== "ok") return { status: "error", code: current.code, effects: [effect] };
            if (current.note.version !== expectedVersion) return { status: "conflict", code: "STALE_VERSION", effects: [effect] };
            try {
                await unlink(await this.safePath(canonical));
                effect.completed = true;
                return { status: "ok", effects: [effect] };
            } catch {
                const after = await this.readVersioned(canonical);
                if (after.status === "error" && after.code === "NOTE_NOT_FOUND") {
                    effect.completed = true;
                    return { status: "ok", effects: [effect] };
                }
                return { status: "indeterminate", effects: [effect] };
            }
        });
    }

    async moveVersioned(from: string, to: string, expectedVersion: string): Promise<BackendMutationResult> {
        let source: string, destination: string;
        try { source = this.normalizePath(from); destination = this.normalizePath(to); }
        catch { return { status: "error", code: "INVALID_PATH", effects: [] }; }
        const effects = [
            { kind: "destination_created" as const, path: destination, completed: false },
            { kind: "source_deleted" as const, path: source, completed: false },
        ];
        return this.withLocks([source, destination], async () => {
            const current = await this.readVersioned(source);
            if (current.status !== "ok") return { status: "error", code: current.code, effects };
            if (current.note.version !== expectedVersion) return { status: "conflict", code: "STALE_VERSION", effects };
            const sourceMode = (current.note.backendState as { mode: number }).mode;
            const created = await this.createVersionedUnlocked(destination, current.note.bytes, sourceMode);
            effects[0].completed = created.effects.some((effect) => effect.completed);
            if (created.status !== "ok") return { ...created, effects };
            effects[0].completed = true;
            const finalCheck = await this.readVersioned(source);
            if (finalCheck.status !== "ok" || finalCheck.note.version !== expectedVersion) return { status: "partial", code: "STALE_VERSION", effects };
            try {
                await unlink(await this.safePath(source));
                effects[1].completed = true;
                return { status: "ok", note: created.note, effects };
            } catch {
                return { status: "partial", code: "BACKEND_UNAVAILABLE", effects };
            }
        });
    }

    async deleteNote(path: string): Promise<boolean> {
        const fullPath = await this.safePath(path);
        try {
            await unlink(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        const fromPath = await this.safePath(from);
        const toPath = await this.safePath(to);
        try {
            await mkdir(dirname(toPath), { recursive: true });
            await rename(fromPath, toPath);
            return true;
        } catch (e: any) {
            if (e.code === "EXDEV") {
                // Cross-device: fall back to copy-delete
                const content = await this.readNote(from);
                if (content === null) return false;
                const wrote = await this.writeNote(to, content);
                if (!wrote) return false;
                return await this.deleteNote(from);
            }
            return false;
        }
    }

    async getMetadata(path: string): Promise<NoteInfo | null> {
        const fullPath = await this.safePath(path);
        try {
            const [content, s] = await Promise.all([
                readFile(fullPath, "utf-8"),
                stat(fullPath),
            ]);
            return {
                path,
                size: s.size,
                ctime: s.birthtimeMs || s.ctimeMs,
                mtime: s.mtimeMs,
                ...parseFrontmatterAndLinks(content),
            };
        } catch {
            return null;
        }
    }

    async listNotes(folder?: string): Promise<string[]> {
        const notes = await this.listNotesWithMtime(folder);
        return notes.map((n) => n.path);
    }

    async listNotesWithMtime(folder?: string): Promise<NoteListing[]> {
        if (folder && !folder.endsWith("/") && !folder.endsWith("\\")) folder += "/";
        const searchDir = folder ? await this.safeFolder(folder) : this.root;
        const entries: string[] = [];
        try {
            for await (const entry of glob("**/*.md", { cwd: searchDir })) {
                const full = folder ? `${folder}${entry}` : entry;
                if (full.startsWith(".obsidian/") || full.includes("/.obsidian/")) continue;
                entries.push(full);
            }
        } catch {
            return [];
        }
        const results = await Promise.all(
            entries.map(async (p) => {
                try {
                    const s = await stat(resolve(this.root, p));
                    return { path: p, mtime: s.mtimeMs };
                } catch {
                    return { path: p, mtime: 0 };
                }
            }),
        );
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }

}
