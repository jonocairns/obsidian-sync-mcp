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

test(`deleted conflict leaves affect versions without blocking mutation`, async () => {
    await fixture(async (a, _b, request) => {
        const created = await a.createVersioned("Conflict/deleted.md", encode("initial"));
        assert.equal(created.status, "ok");
        const id = await a.manipulator.path2id("Conflict/deleted.md");
        const raw = await request(encodeURIComponent(id));
        const [generation, parent] = raw._rev.split("-");
        const liveRevision = `${Number(generation) + 1}-${"f".repeat(32)}`;
        const deletedRevision = `${Number(generation) + 1}-${"a".repeat(32)}`;
        await request("_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs: [{
            ...raw, _rev: liveRevision,
            _revisions: { start: Number(generation) + 1, ids: ["f".repeat(32), parent] },
        }] }) });
        const liveOnly = await a.readVersioned("Conflict/deleted.md");
        assert.equal(liveOnly.status, "ok");
        if (liveOnly.status !== "ok") throw new Error("live successor read failed");
        assert.deepEqual(liveOnly.note.conflicts, []);

        await request("_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs: [{
            ...raw, _rev: deletedRevision, _deleted: true,
            _revisions: { start: Number(generation) + 1, ids: ["a".repeat(32), parent] },
        }] }) });
        const check = await request(`${encodeURIComponent(id)}?conflicts=true&deleted_conflicts=true`);
        assert.ok(check._deleted_conflicts.includes(deletedRevision), "fixture must have a deleted sibling");
        const throughPouch = await a.manipulator.liveSyncLocalDB.getRaw(id, { conflicts: true, deleted_conflicts: true });
        console.log(`deleted-conflict diagnostic: HTTP=${check._deleted_conflicts.length}; PouchDB=${throughPouch._deleted_conflicts?.length ?? 0}`);
        const read = await a.readVersioned("Conflict/deleted.md");
        assert.equal(read.status, "ok");
        if (read.status !== "ok") throw new Error("deleted-sibling read failed");
        assert.deepEqual(read.note.conflicts, [], "deleted sibling was exposed as an actionable conflict");
        assert.notEqual(read.note.version, liveOnly.note.version, "deleted sibling was omitted from opaque version state");
        const replacement = await a.replaceVersioned("Conflict/deleted.md", read.note.version, encode("replacement"));
        assert.equal(replacement.status, "ok");
    });
});

test(`read-only checks and unrelated moves cannot tombstone another note`, async () => {
    await fixture(async (a, _b, request) => {
        const probePath = "Diagnostics/mcp-create-probe.md";
        const probeBytes = encode("x".repeat(274));
        const created = await a.createVersioned(probePath, probeBytes);
        assert.equal(created.status, "ok");

        const probeIdBefore = await a.manipulator.path2id(probePath);
        const metadataBefore = await a.manipulator.readRevisionMetadata(probeIdBefore);
        const rawBefore = await request(`${encodeURIComponent(probeIdBefore)}?conflicts=true&deleted_conflicts=true`);
        assert.equal(rawBefore._deleted, undefined);
        assert.deepEqual(metadataBefore._conflicts, []);
        assert.deepEqual(metadataBefore._deleted_conflicts, []);

        // read_note and get_note_metadata both reduce to readVersioned at the
        // CouchDB boundary. Search and backlink lookups use the local index and
        // therefore add no vault-side operation to this sequence.
        for (let i = 0; i < 4; i++) {
            const read = await a.readVersioned(probePath);
            assert.equal(read.status, "ok");
            if (read.status === "ok") assert.deepEqual(read.note.bytes, probeBytes);
        }

        for (let i = 0; i < 4; i++) {
            const source = `Moves/source-${i}.md`;
            const destination = `Moves/archive/source-${i}.md`;
            const note = await a.createVersioned(source, encode(`source ${i}`));
            assert.equal(note.status, "ok");
            if (note.status !== "ok") throw new Error("move fixture creation failed");
            const moved = await a.moveVersioned(source, destination, note.note.version);
            assert.equal(moved.status, "ok");
        }

        const probeIdAfter = await a.manipulator.path2id(probePath);
        const metadataAfter = await a.manipulator.readRevisionMetadata(probeIdAfter);
        const rawAfter = await request(`${encodeURIComponent(probeIdAfter)}?conflicts=true&deleted_conflicts=true`);
        const finalRead = await a.readVersioned(probePath);

        assert.equal(probeIdAfter, probeIdBefore, "unrelated writes changed the obfuscated path mapping");
        assert.equal(metadataAfter._rev, metadataBefore._rev, "a read-only probe acquired a new revision");
        assert.deepEqual(metadataAfter._conflicts, []);
        assert.deepEqual(metadataAfter._deleted_conflicts, []);
        assert.equal(rawAfter._deleted, undefined);
        assert.equal(rawAfter._rev, rawBefore._rev);
        assert.equal(finalRead.status, "ok", "the probe became a tombstone without a delete");
    }, true);
});

test(`pre-fix binary Markdown remains malformed but reads do not tombstone it`, async () => {
    await fixture(async (a, _b, request) => {
        const { createBinaryBlob, readAsBlob } = await import("@vrtmrz/livesync-commonlib/compat/common/utils");
        const path = "Legacy/mcp-create-probe.md";
        const bytes = encode("x".repeat(274));
        const now = Date.now();

        // Reproduce the guardedPut call removed by PR #20.
        const committed = await a.manipulator.put(
            path,
            createBinaryBlob(Uint8Array.from(bytes)),
            { ctime: now, mtime: now, size: bytes.byteLength },
            "plain",
            undefined,
            true,
        );
        assert.equal(committed, true);

        const id = await a.manipulator.path2id(path);
        const metadataBefore = await a.manipulator.readRevisionMetadata(id);
        const entry = await a.manipulator.liveSyncLocalDB.getDBEntry(path);
        assert.ok(entry);
        const clientBlob = readAsBlob(entry);
        assert.equal(entry.type, "newnote", "fixture must reproduce the pre-PR #20 binary representation");
        assert.notEqual(clientBlob.size, entry.size, "fixture must reproduce the client size mismatch");

        for (let i = 0; i < 8; i++) {
            const read = await a.readVersioned(path);
            assert.equal(read.status, "ok", "server reads unexpectedly tombstoned malformed Markdown");
            if (read.status === "ok") assert.deepEqual(read.note.bytes, bytes);
        }

        const metadataAfter = await a.manipulator.readRevisionMetadata(id);
        const rawAfter = await request(`${encodeURIComponent(id)}?conflicts=true&deleted_conflicts=true`);
        assert.equal(metadataAfter._rev, metadataBefore._rev, "reads rewrote the malformed document");
        assert.deepEqual(metadataAfter._conflicts, []);
        assert.deepEqual(metadataAfter._deleted_conflicts, []);
        assert.equal(rawAfter._deleted, undefined);
    }, true);
});

test(`offline scanner tombstones only when last-seen state is poisoned`, async () => {
    const { FullScanModes, synchroniseAllFilesBetweenDBandStorage } = await import(
        "@vrtmrz/livesync-commonlib/compat/serviceFeatures/offlineScanner"
    );
    const path = "missing.md";
    const document = {
        _id: path, path, type: "newnote", datatype: "newnote", size: 274,
        ctime: 10_000, mtime: 10_000, children: [], eden: {},
    };

    const scenario = (initialFileStatus: Record<string, number>) => {
        let persistedFileStatus = { ...initialFileStatus };
        let reflectionCalls = 0;
        let deletionCalls = 0;
        async function* databaseDocuments() { yield document; }
        const host = {
            services: {
                context: { events: { emitEvent: () => undefined } },
                setting: { currentSettings: () => ({ handleFilenameCaseSensitive: true }) },
                vault: {
                    isTargetFile: async () => true,
                    isValidPath: () => true,
                    isFileSizeTooLarge: () => false,
                },
                path: {
                    getPath: (doc: typeof document) => doc.path,
                    path2id: async () => path,
                },
                fileProcessing: {},
                database: { localDatabase: { findAllNormalDocs: () => databaseDocuments() } },
                keyValueDB: { kvDB: {
                    get: async (key: string) => key === "fileStatusMap" ? { ...persistedFileStatus } : undefined,
                    set: async (key: string, value: Record<string, number>) => {
                        if (key === "fileStatusMap") persistedFileStatus = { ...value };
                    },
                } },
            },
            serviceModules: {
                storageAccess: { getFiles: async () => [], delete: async () => undefined },
                fileHandler: {
                    dbToStorage: async () => { reflectionCalls++; return false; },
                    storeFileToDB: async () => undefined,
                    deleteFileFromDB: async () => { deletionCalls++; return true; },
                },
            },
        } as any;
        return {
            host,
            state: () => ({ persistedFileStatus, reflectionCalls, deletionCalls }),
        };
    };
    const log = () => undefined;
    const waitForStatusSave = () => new Promise((resolve) => setTimeout(resolve, 20));

    // A failed first reflection must stay retryable. It must not manufacture
    // evidence that the file previously existed on local storage.
    const clean = scenario({});
    const first = await synchroniseAllFilesBetweenDBandStorage(
        clean.host, log, {} as any, { mode: FullScanModes.DB_APPLY },
    );
    await waitForStatusSave();
    assert.equal(first, false);
    assert.deepEqual(clean.state().persistedFileStatus, {});

    const second = await synchroniseAllFilesBetweenDBandStorage(
        clean.host, log, {} as any, { mode: FullScanModes.NEWER_WINS },
    );
    await waitForStatusSave();
    assert.equal(second, false);
    assert.equal(clean.state().reflectionCalls, 2);
    assert.equal(clean.state().deletionCalls, 0);

    // This is the state manufactured by the pre-0.1.11 bug: the failed
    // reflection's database mtime was saved as if it came from a real file.
    const poisoned = scenario({ [path]: document.mtime });
    const poisonedResult = await synchroniseAllFilesBetweenDBandStorage(
        poisoned.host, log, {} as any, { mode: FullScanModes.NEWER_WINS },
    );
    await waitForStatusSave();
    assert.equal(poisonedResult, true);
    assert.equal(poisoned.state().reflectionCalls, 0);
    assert.equal(poisoned.state().deletionCalls, 1);
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

for (const encrypted of [false, true]) {
    const mode = encrypted ? "encrypted/obfuscated" : "plaintext";

    test(`seam audit: native metadata, path aliases, replacement and soft-delete feed (${mode})`, async () => {
        await fixture(async (a, b) => {
            const path = "Seam/Unicode café 😀.md";
            const body = "# Metadata\r\nこんにちは 😀\r\n";
            const info = { ctime: 1700000000123, mtime: 1700001000456, size: encode(body).byteLength };
            assert.equal(await b.manipulator.put(path, new Blob([body], { type: "text/plain" }), info), true);
            const read = await a.readVersioned(path);
            assert.equal(read.status, "ok");
            assert.deepEqual(read.note.bytes, encode(body));
            for (const field of ["ctime", "mtime", "size"] as const) assert.equal(read.note[field], info[field]);
            assert.equal(read.note.path, path);
            assert.deepEqual(read.note.conflicts, []);
            assert.equal(await a.manipulator.path2id(path), await a.manipulator.path2id(path.toLowerCase()));
            assert.equal((await a.createVersioned(path.toLowerCase(), encode("duplicate"))).code, "DESTINATION_EXISTS");
            assert.ok((await a.listNotes()).includes(path));

            const events: Array<[string, string | null, number | undefined]> = [];
            const checkpoint = await a.catchUp("0", (p: string, text: string | null, mtime?: number) => events.push([p, text, mtime]));
            assert.ok(events.some(([p, text, mtime]) => p === path && text === body && mtime === info.mtime));
            const replaced = await a.replaceVersioned(path, read.note.version, encode(""));
            assert.equal(replaced.status, "ok");
            assert.equal(replaced.note.ctime, info.ctime);
            assert.ok(replaced.note.mtime >= info.mtime);
            assert.equal(replaced.note.size, 0);
            const emptyEvents: Array<string | null> = [];
            const next = await a.catchUp(checkpoint, (_p: string, text: string | null) => emptyEvents.push(text));
            assert.deepEqual(emptyEvents, [""]);
            assert.equal((await a.deleteVersioned(path, replaced.note.version)).status, "ok");
            const deletedEvents: Array<string | null> = [];
            await a.catchUp(next, (_p: string, text: string | null) => deletedEvents.push(text));
            assert.deepEqual(deletedEvents, [null]);
            assert.equal((await a.readVersioned(path)).code, "RESTORE_REQUIRED");
            assert.equal((await a.createVersioned(path, encode("recreate"))).code, "RESTORE_REQUIRED");
            assert.ok(!(await a.listNotes()).includes(path));
        }, encrypted);
    });

    test(`seam audit: inline eden chunks retain ordering and repetitions (${mode})`, async () => {
        await fixture(async (a, b) => {
            const path = "Seam/eden.md";
            const db = b.manipulator.liveSyncLocalDB;
            const pieces = ["# Eden 😀\n", "second\r\n"];
            const ids = await Promise.all(pieces.map(async (piece) => (await db.managers.entryManager.prepareChunk(piece)).id));
            const body = pieces[0] + pieces[1] + pieces[0];
            assert.equal((await db.putRaw({
                _id: await b.manipulator.path2id(path), path, type: "plain",
                ctime: 1700000000000, mtime: 1700000000001, size: encode(body).byteLength,
                children: [ids[0], ids[1], ids[0]],
                eden: Object.fromEntries(ids.map((id, i) => [id, { data: pieces[i], epoch: 1 }])),
            })).ok, true);
            // No separate leaf documents exist; the reader must use inline eden data.
            const read = await a.readVersioned(path);
            assert.equal(read.status, "ok");
            assert.deepEqual(read.note.bytes, encode(body));
            const events: string[] = [];
            await a.catchUp("0", (_p: string, content: string) => events.push(content));
            assert.deepEqual(events, [body]);
        }, encrypted);
    });

    test(`seam audit: CouchDB tombstones block reads and recreation (${mode})`, async () => {
        await fixture(async (a, _b, request) => {
            const path = "Seam/hard-deleted.md";
            assert.equal((await a.createVersioned(path, encode("original"))).status, "ok");
            const id = await a.manipulator.path2id(path);
            const raw = await request(encodeURIComponent(id));
            await request(`${encodeURIComponent(id)}?rev=${raw._rev}`, { method: "DELETE" });
            assert.equal((await a.readVersioned(path)).code, "RESTORE_REQUIRED");
            assert.equal((await a.createVersioned(path, encode("replacement"))).code, "RESTORE_REQUIRED");
            assert.ok(!(await a.listNotes()).includes(path));
        }, encrypted);
    });
}

test("seam audit: binary Markdown direct reads and catch-up agree", async () => {
    await fixture(async (a, b) => {
        const path = "Seam/binary.md";
        const body = "# Binary compatibility\n日本語 😀";
        assert.equal(await b.manipulator.put(path, new Blob([body], { type: "application/octet-stream" }), {
            ctime: 1700000000000, mtime: 1700000000001, size: encode(body).byteLength,
        }), true);
        assert.equal(await a.readNote(path), body);
        const events: string[] = [];
        await a.catchUp("0", (_p: string, content: string) => events.push(content));
        assert.deepEqual(events, [body]);
    }, true);
});

test("seam audit: metadata-free tombstone removes a previously indexed note", async () => {
    await fixture(async (a, _b, request) => {
        const path = "Seam/feed-tombstone.md";
        assert.equal((await a.createVersioned(path, encode("indexed"))).status, "ok");
        const checkpoint = await a.catchUp("0", () => {});
        const id = await a.manipulator.path2id(path);
        const raw = await request(encodeURIComponent(id));
        await request(`${encodeURIComponent(id)}?rev=${raw._rev}`, { method: "DELETE" });
        const changes = await request(`_changes?since=${encodeURIComponent(checkpoint)}&include_docs=true`);
        assert.ok(changes.results.some((change: any) => change.id === id && change.deleted && !change.doc.path));
        const events: Array<[string, string | null]> = [];
        await a.catchUp(checkpoint, (p: string, content: string | null) => events.push([p, content]));
        assert.deepEqual(events, [[path, null]]);
    }, true);
});

test("seam audit: legacy inline notes do not silently lose their body on direct read", async () => {
    await fixture(async (a, b) => {
        const path = "Seam/legacy.md";
        const body = "legacy inline body";
        const encoded = Buffer.from(body).toString("base64");
        const raw = {
            _id: await b.manipulator.path2id(path), path, type: "notes", data: encoded,
            ctime: 1700000000000, mtime: 1700000000001, size: encode(body).byteLength, eden: {},
        };
        assert.equal((await b.manipulator.liveSyncLocalDB.putRaw(raw)).ok, true);
        const viaMetadata = await a.manipulator.getByMeta(raw);
        assert.equal(viaMetadata.data, encoded, "library metadata-based reader recognizes this legacy fixture");
        const { decodeBinary } = await import("@vrtmrz/livesync-commonlib/compat/string_and_binary/convert");
        assert.deepEqual(new Uint8Array(decodeBinary(viaMetadata.data)), encode(body));
        assert.equal(await a.readNote(path), body);
        const read = await a.readVersioned(path);
        assert.equal(read.status, "ok");
        const moved = await a.moveVersioned(path, "Seam/legacy-moved.md", read.note.version);
        assert.equal(moved.status, "ok");
        assert.equal(await a.readNote("Seam/legacy-moved.md"), body);
        assert.equal((await a.readVersioned(path)).code, "RESTORE_REQUIRED");
    });
});

for (const encrypted of [false, true]) {
    test(`tombstone identity survives restart (encrypted=${encrypted})`, async () => {
        await fixture(async (a, b, request) => {
            const path = "Restart/deleted.md";
            assert.equal((await a.createVersioned(path, encode("indexed"))).status, "ok");
            const checkpoint = await a.catchUp("0", () => {});
            await a.close();
            const id = await b.manipulator.path2id(path);
            const raw = await request(encodeURIComponent(id));
            await request(`${encodeURIComponent(id)}?rev=${raw._rev}`, { method: "DELETE" });
            const restarted = new Vault(b.config);
            try {
                await restarted.init();
                const removals: Array<[string, string | null]> = [];
                await restarted.catchUp(checkpoint, (p, content) => removals.push([p, content]), undefined, [path]);
                assert.deepEqual(removals, [[path, null]]);
                // A fresh empty index need not recover an unindexed tombstone's path.
                await restarted.catchUp("0", () => { throw new Error("cold index has no deleted note to remove"); }, undefined, []);
            } finally { await restarted.close(); }
        }, encrypted);
    });
}

async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("change event timed out")), 10000);
        })]);
    } finally { clearTimeout(timer!); }
}

test("live feed decodes binary and legacy bodies and observes metadata-free deletions", async () => {
    await fixture(async (a, b, request) => {
        await a.catchUp("0", () => {});
        let accept: (event: [string, string | null]) => void = () => {};
        a.watchChanges((path: string, content: string | null) => accept([path, content]));
        for (const type of ["newnote", "notes"]) {
            const path = `Watch/${type}.md`;
            const body = `# ${type}\n日本語 😀`;
            const created = new Promise<[string, string | null]>((resolve) => { accept = resolve; });
            if (type === "newnote") {
                assert.equal(await b.manipulator.put(path, new Blob([body], { type: "application/octet-stream" }), {
                    ctime: 1700000000000, mtime: 1700000000001, size: encode(body).byteLength,
                }), true);
            } else {
                assert.equal((await b.manipulator.liveSyncLocalDB.putRaw({
                    _id: await b.manipulator.path2id(path), path, type: "notes", data: Buffer.from(body).toString("base64"),
                    ctime: 1700000000000, mtime: 1700000000001, size: encode(body).byteLength, eden: {},
                })).ok, true);
            }
            assert.deepEqual(await within(created), [path, body]);
            const removed = new Promise<[string, string | null]>((resolve) => { accept = resolve; });
            const id = await b.manipulator.path2id(path);
            const raw = await request(encodeURIComponent(id));
            await request(`${encodeURIComponent(id)}?rev=${raw._rev}`, { method: "DELETE" });
            assert.deepEqual(await within(removed), [path, null]);
        }
    }, true);
});

test("live feed resolves a tool-indexed path even if its create event was coalesced away", async () => {
    await fixture(async (a, b, request) => {
        await a.catchUp("0", () => {});
        const path = "Watch/coalesced.md";
        assert.equal((await b.createVersioned(path, encode("indexed by another code path"))).status, "ok");
        const id = await b.manipulator.path2id(path);
        const raw = await request(encodeURIComponent(id));
        await request(`${encodeURIComponent(id)}?rev=${raw._rev}`, { method: "DELETE" });
        const removed = new Promise<[string, string | null]>((resolve) => {
            a.watchChanges((p: string, content: string | null) => resolve([p, content]), () => [path]);
        });
        assert.deepEqual(await within(removed), [path, null]);
    }, true);
});

test("catch-up does not checkpoint past a failed load and can replay a failed removal", async () => {
    await fixture(async (a, b, request) => {
        const path = "Retry/deleted.md";
        assert.equal((await b.createVersioned(path, encode("retryable"))).status, "ok");
        const load = a.manipulator.getByMeta.bind(a.manipulator);
        a.manipulator.getByMeta = async () => { throw new Error("injected decode failure"); };
        let checkpoints = 0;
        await assert.rejects(a.catchUp("0", () => {}, () => { checkpoints++; }), /injected decode failure/);
        assert.equal(checkpoints, 0);
        a.manipulator.getByMeta = load;
        const checkpoint = await a.catchUp("0", () => {});
        const id = await b.manipulator.path2id(path);
        const raw = await request(encodeURIComponent(id));
        await request(`${encodeURIComponent(id)}?rev=${raw._rev}`, { method: "DELETE" });
        await assert.rejects(a.catchUp(checkpoint, () => { throw new Error("injected index failure"); }), /injected index failure/);
        const removals: string[] = [];
        await a.catchUp(checkpoint, (p: string, content: string | null) => { if (content === null) removals.push(p); });
        assert.deepEqual(removals, [path]);
    }, true);
});
