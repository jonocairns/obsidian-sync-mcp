/** Production adapter contracts against real CouchDB. Only UUID-owned test databases are modified. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setGlobalLogFunction } from "octagonal-wheels/common/logger";

setGlobalLogFunction(() => {});
const { Vault } = await import("../src/vault.js");
const url = process.env.TEST_COUCHDB_URL ?? "http://localhost:5985";
assert.ok(url, "Set TEST_COUCHDB_URL to the disposable CouchDB instance");
const username = process.env.TEST_COUCHDB_USER ?? "admin";
const password = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, "Content-Type": "application/json" };
const encode = (value: string) => new TextEncoder().encode(value);

async function fixture(run: (a: any, b: any, request: (suffix: string, init?: RequestInit) => Promise<any>) => Promise<void>, encrypted = false, connectionUrl = url) {
    const database = `commonlib-proof-${randomUUID().replaceAll("-", "")}`;
    const response = await fetch(`${url}/${database}`, { method: "PUT", headers });
    assert.equal(response.status, 201);
    const config = { couchdbUrl: connectionUrl, couchdbUser: username, couchdbPassword: password, database,
        ...(encrypted ? { passphrase: "compatibility-proof", obfuscatePaths: true } : {}) };
    const a = new Vault(config);
    const b = new Vault(config);
    const request = async (suffix: string, init: RequestInit = {}) => {
        const result = await fetch(`${url}/${database}/${suffix}`, { ...init, headers });
        assert.ok(result.ok, `CouchDB request failed: ${result.status}`);
        return result.json();
    };
    try {
        await a.init(); await b.init();
        await run(a, b, request);
    } finally {
        await Promise.allSettled([a.close(), b.close()]);
        const removed = await fetch(`${url}/${database}`, { method: "DELETE", headers });
        assert.ok(removed.ok, "Could not delete owned test database");
    }
}

// Pause the first client after its application precheck, then complete a second
// client's real CouchDB write. No network errors or library responses are mocked.
function interleave(object: any, method: string, action: () => Promise<void>) {
    const original = object[method].bind(object);
    object[method] = async (...args: unknown[]) => {
        object[method] = original;
        await action();
        return original(...args);
    };
}

for (const encrypted of [false, true]) {
    const mode = encrypted ? "encrypted/obfuscated" : "plaintext";
    test(`create cannot overwrite a concurrent creator (${mode})`, async () => {
        await fixture(async (a, b) => {
            interleave(a.manipulator, "put", async () => {
                assert.equal(await b.writeNote("Race/create.md", "competitor"), true);
            });
            const result = await a.createVersioned("Race/create.md", encode("stale creator"));
            assert.equal(await b.readNote("Race/create.md"), "competitor", "concurrent creator's bytes were overwritten");
            assert.equal(result.status, "conflict");
            assert.equal(result.code, "DESTINATION_EXISTS");
        }, encrypted);
    });

    test(`replace rejects a revision advanced after precheck (${mode})`, async () => {
        await fixture(async (a, b) => {
            const initial = await a.createVersioned("Race/replace.md", encode("initial"));
            assert.equal(initial.status, "ok");
            interleave(a.manipulator, "put", async () => {
                assert.equal(await b.writeNote("Race/replace.md", "competitor"), true);
            });
            const result = await a.replaceVersioned("Race/replace.md", initial.note.version, encode("stale replacement"));
            assert.equal(await b.readNote("Race/replace.md"), "competitor", "concurrent writer's bytes were overwritten");
            assert.equal(result.status, "conflict");
            assert.equal(result.code, "STALE_VERSION");
        }, encrypted);
    });

    test(`delete rejects a revision advanced after precheck (${mode})`, async () => {
        await fixture(async (a, b) => {
            const initial = await a.createVersioned("Race/delete.md", encode("initial"));
            assert.equal(initial.status, "ok");
            interleave(a.manipulator,
                "strictDelete", async () => {
                assert.equal(await b.writeNote("Race/delete.md", "competitor"), true);
            });
            const result = await a.deleteVersioned("Race/delete.md", initial.note.version);
            const after = await b.readVersioned("Race/delete.md");
            assert.equal(after.status, "ok", "concurrent writer's note was deleted");
            assert.equal(new TextDecoder().decode(after.note.bytes), "competitor");
            assert.equal(after.note.conflicts.length, 0, "stale delete created a conflict branch");
            assert.equal(result.status, "conflict");
            assert.equal(result.code, "STALE_VERSION");
        }, encrypted);
    });
}

test(`deleted conflict leaves affect versions and block mutation`, async () => {
    await fixture(async (a, _b, request) => {
        const created = await a.createVersioned("Conflict/deleted.md", encode("initial"));
        assert.equal(created.status, "ok");
        const id = await a.manipulator.path2id("Conflict/deleted.md");
        const raw = await request(encodeURIComponent(id));
        const [generation, parent] = raw._rev.split("-");
        const deletedRevision = `${Number(generation) + 1}-${"a".repeat(32)}`;
        await request("_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs: [{
            ...raw, _rev: deletedRevision, _deleted: true,
            _revisions: { start: Number(generation) + 1, ids: ["a".repeat(32), parent] },
        }, {
            ...raw, _rev: `${Number(generation) + 1}-${"f".repeat(32)}`,
            _revisions: { start: Number(generation) + 1, ids: ["f".repeat(32), parent] },
        }] }) });
        const check = await request(`${encodeURIComponent(id)}?conflicts=true&deleted_conflicts=true`);
        assert.ok(check._deleted_conflicts.includes(deletedRevision), "fixture must have a deleted sibling");
        const throughPouch = await a.manipulator.liveSyncLocalDB.getRaw(id, { conflicts: true, deleted_conflicts: true });
        console.log(`deleted-conflict diagnostic: HTTP=${check._deleted_conflicts.length}; PouchDB=${throughPouch._deleted_conflicts?.length ?? 0}`);
        const read = await a.readVersioned("Conflict/deleted.md");
        assert.equal(read.status, "ok");
        assert.ok(read.note.conflicts.includes(deletedRevision), "deleted sibling was omitted from MCP state");
        const replacement = await a.replaceVersioned("Conflict/deleted.md", read.note.version, encode("must refuse"));
        assert.equal(replacement.status, "conflict");
        assert.equal(replacement.code, "PRE_EXISTING_CONFLICT");
    });
});

for (const encrypted of [false, true]) {
    const mode = encrypted ? "encrypted/obfuscated" : "plaintext";
    test(`public live-base API rejects stale replacement (${mode})`, async () => {
        await fixture(async (a, b) => {
            const path = "Lower/replace.md";
            const initial = await a.createVersioned(path, encode("initial"));
            assert.equal(initial.status, "ok");
            const db = a.manipulator.liveSyncLocalDB;
            const blob = new Blob(["replacement"], { type: "text/plain" });
            const note = { _id: await a.manipulator.path2id(path), path, data: blob,
                ctime: initial.note.ctime, mtime: Date.now(), size: blob.size,
                type: "plain", datatype: "plain", eden: {}, children: [] };
            assert.equal(await b.writeNote(path, "competitor"), true);
            const stale = await db.putDBEntryWithLiveBaseRevision(note, initial.note.backendState.winnerRevision);
            assert.equal(stale, false, "upstream returns false rather than throwing the 409");
            assert.equal(await b.readNote(path), "competitor");
            const fresh = await a.readVersioned(path);
            const saved = await db.putDBEntryWithLiveBaseRevision(note, fresh.note.backendState.winnerRevision);
            assert.ok(saved && saved.ok);
            assert.equal(await b.readNote(path), "replacement");
        }, encrypted);
    });

    test(`raw public API can implement strict soft deletion (${mode})`, async () => {
        await fixture(async (a, b) => {
            const path = "Lower/delete.md";
            const initial = await a.createVersioned(path, encode("initial"));
            assert.equal(initial.status, "ok");
            const db = a.manipulator.liveSyncLocalDB;
            const id = await a.manipulator.path2id(path);
            const stale = await db.getRaw(id);
            assert.equal(await b.writeNote(path, "competitor"), true);
            await assert.rejects(db.putRaw({ ...stale, deleted: true, mtime: Date.now() }), { status: 409 });
            assert.equal(await b.readNote(path), "competitor");
            const fresh = await db.getRaw(id);
            const result = await db.putRaw({ ...fresh, deleted: true, mtime: Date.now() });
            assert.equal(result.ok, true);
            const deleted = await a.readVersioned(path);
            assert.equal(deleted.status, "error");
            assert.equal(deleted.code, "RESTORE_REQUIRED");
        }, encrypted);
    });
}

test(`empty and multi-chunk Unicode byte roundtrips`, async () => {
    await fixture(async (a) => {
        for (const [path, content] of [["Bytes/empty.md", ""], ["Bytes/large.md", "# Тест 😀\r\n".repeat(20000)]]) {
            const bytes = encode(content);
            const created = await a.createVersioned(path, bytes);
            assert.equal(created.status, "ok");
            const read = await a.readVersioned(path);
            assert.equal(read.status, "ok");
            assert.deepEqual(read.note.bytes, bytes);
        }
    }, true);
});

test(`catch-up checkpoint, watch update, and restart`, async () => {
    await fixture(async (a, b) => {
        await b.writeNote("Feed/one.md", "first");
        const caught: string[] = [];
        const since = await a.catchUp("0", (path: string) => caught.push(path));
        assert.ok(caught.includes("Feed/one.md"));
        let resolveUpdate!: () => void;
        const updated = new Promise<void>((resolve) => { resolveUpdate = resolve; });
        a.watchChanges((path: string, content: string | null) => {
            if (path === "Feed/one.md" && content === "second") resolveUpdate();
        });
        await b.writeNote("Feed/one.md", "second");
        let timer: ReturnType<typeof setTimeout>;
        try {
            await Promise.race([updated, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("watch update timed out")), 10000);
            })]);
        } finally { clearTimeout(timer!); }
        await a.close();
        const restart = new Vault(b.config);
        try {
            await restart.init();
            const resumed: Array<[string, string | null]> = [];
            await restart.catchUp(since, (path: string, content: string | null) => resumed.push([path, content]));
            assert.ok(resumed.some(([path, content]) => path === "Feed/one.md" && content === "second"));
        } finally { await restart.close(); }
    });
});

test(`conflict snapshot and bytes stay on one revision during a read race`, async () => {
    await fixture(async (a, b) => {
        const path = "Read/snapshot.md";
        const initial = await a.createVersioned(path, encode("snapshot"));
        assert.equal(initial.status, "ok");
        const readMetadata = a.manipulator.readRevisionMetadata.bind(a.manipulator);
        a.manipulator.readRevisionMetadata = async (id: string) => {
            a.manipulator.readRevisionMetadata = readMetadata;
            const snapshot = await readMetadata(id);
            assert.equal(await b.writeNote(path, "newer bytes"), true);
            return snapshot;
        };
        const read = await a.readVersioned(path);
        assert.equal(read.status, "ok");
        assert.equal(read.note.version, initial.note.version);
        assert.equal(new TextDecoder().decode(read.note.bytes), "snapshot");
        assert.equal(await b.readNote(path), "newer bytes");
    }, true);
});

test(`failed chunk storage cannot commit file metadata`, async () => {
    await fixture(async (a, _b, request) => {
        // Fault injection covers the new orchestration boundary: a library
        // chunk failure must not become a successful but unreadable file.
        a.manipulator.liveSyncLocalDB.managers.chunkManager.write = async () => ({
            result: false, processed: { cached: 0, hotPack: 0, written: 0, duplicated: 0 },
        });
        const result = await a.createVersioned("Failure/chunk.md", encode("must not appear"));
        assert.equal(result.status, "error");
        assert.equal(result.code, "BACKEND_UNAVAILABLE");
        const rows = await request("_all_docs?include_docs=true");
        assert.equal(rows.rows.some((row: any) => row.doc?.path === "Failure/chunk.md"), false);
    });
});

test(`native upstream reader can decode adapter-created chunks`, async () => {
    await fixture(async (a, b) => {
        const { DirectFileManipulator } = await import("@vrtmrz/livesync-commonlib");
        const { readAsBlob } = await import("@vrtmrz/livesync-commonlib/compat/common/utils");
        const native = new DirectFileManipulator(a.manipulator.options);
        try {
            await native.ready.promise;
            const path = "Interop/large.md";
            const bytes = encode("# unmodified reader 😀\r\n".repeat(25000));
            assert.equal((await a.createVersioned(path, bytes)).status, "ok");
            const read = await native.get(path as any);
            assert.ok(read && Array.isArray(read.data));
            assert.equal(read.type, "plain");
            const blob = readAsBlob(read);
            assert.equal(blob.size, read.size);
            assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
            assert.equal(await native.put("Interop/native.md", new Blob(["native writer"], { type: "text/plain" }), {
                ctime: Date.now(), mtime: Date.now(), size: 13,
            }), true);
            assert.equal(await b.readNote("Interop/native.md"), "native writer");
        } finally { await native.close(); }
    }, true);
});

test(`partial move preserves a concurrently updated source`, async () => {
    await fixture(async (a, b) => {
        const initial = await a.createVersioned("Move/source.md", encode("source"));
        assert.equal(initial.status, "ok");
        interleave(a.manipulator, "strictDelete", async () => {
            assert.equal(await b.writeNote("Move/source.md", "new source"), true);
        });
        const result = await a.moveVersioned("Move/source.md", "Move/destination.md", initial.note.version);
        assert.notEqual(result.status, "ok");
        assert.equal(await b.readNote("Move/source.md"), "new source");
        assert.equal(await b.readNote("Move/destination.md"), "source");
        assert.deepEqual(result.effects, [
            { kind: "destination_created", path: "Move/destination.md", completed: true },
            { kind: "source_deleted", path: "Move/source.md", completed: false },
        ]);
    }, true);
});

test("credentialed URLs use explicit credentials for every versioned operation", async () => {
    const connection = new URL(url);
    // Deliberately differ from the valid explicit credentials. Both PouchDB
    // and the metadata fetch must use couchdbUser/couchdbPassword.
    connection.username = "ignored-user";
    connection.password = "ignored-password";
    await fixture(async (a) => {
        assert.equal(await a.writeNote("Credentials/legacy.md", "legacy"), true);
        const created = await a.createVersioned("Credentials/source.md", encode("initial"));
        assert.equal(created.status, "ok");
        const read = await a.readVersioned("Credentials/source.md");
        assert.equal(read.status, "ok");
        assert.equal(new TextDecoder().decode(read.note.bytes), "initial");
        const replaced = await a.replaceVersioned("Credentials/source.md", read.note.version, encode("updated"));
        assert.equal(replaced.status, "ok");
        const moved = await a.moveVersioned("Credentials/source.md", "Credentials/destination.md", replaced.note.version);
        assert.equal(moved.status, "ok");
        const destination = await a.readVersioned("Credentials/destination.md");
        assert.equal(destination.status, "ok");
        assert.equal(new TextDecoder().decode(destination.note.bytes), "updated");
        const deleted = await a.deleteVersioned("Credentials/destination.md", destination.note.version);
        assert.equal(deleted.status, "ok");
        assert.equal((await a.readVersioned("Credentials/destination.md")).code, "RESTORE_REQUIRED");
    }, true, connection.toString().replace(/\/+$/, ""));
});
