/**
 * E2E test for the COUCHDB_OBFUSCATE_PROPERTIES auto-detection (issues #4,
 * #10) and the versioned core against a real CouchDB. It creates uniquely
 * named per-run databases and only deletes those exact resources on success.
 *
 * Run: pnpm test:couchdb  (starts against localhost:5985 by default)
 *
 *   docker run -d --name couchdb-obf-test -p 5985:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test \
 *     couchdb:3@sha256:9ea24cbd76522fe845d1c32c7fd1dcfc8a3ba73dcc4817d62f8a7f7f1dfaffe3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD.
 * (Runs via tsup bundling — plain tsx won't resolve the svelte/pouchdb stubs.)
 *
 * Seeds an obfuscated vault and a plain vault through the same
 * livesync-commonlib write path the Obsidian plugin uses, then reopens each
 * with mismatched settings to exercise detection, auto-correction, and the
 * missing-passphrase fail-fast.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Vault } from "../src/vault.js";

const base = {
    couchdbUrl: process.env.TEST_COUCHDB_URL ?? "http://localhost:5985",
    couchdbUser: process.env.TEST_COUCHDB_USER ?? "admin",
    couchdbPassword: process.env.TEST_COUCHDB_PASSWORD ?? "test",
};
const passphrase = "banana123";
const encoder = new TextEncoder();
const runId = randomUUID().replaceAll("-", "");
const databases = {
    obfuscated: `obsidian-mcp-test-obf-${runId}`,
    plain: `obsidian-mcp-test-plain-${runId}`,
    core: `obsidian-mcp-test-core-${runId}`,
};

const NOTE_CYRILLIC = "Inbox/Тест.md";
const NOTE_DAILY = "Daily/2026-07-21.md";

function step(msg: string) {
    console.log(`\n=== ${msg} ===`);
}

const auth = {
    Authorization: "Basic " + Buffer.from(`${base.couchdbUser}:${base.couchdbPassword}`).toString("base64"),
};

async function rawAllDocIds(db: string): Promise<string[]> {
    const res = await fetch(`${base.couchdbUrl}/${db}/_all_docs`, { headers: auth });
    return ((await res.json()) as any).rows.map((r: any) => r.id);
}

async function rawFileDoc(db: string, path: string): Promise<any> {
    const res = await fetch(`${base.couchdbUrl}/${db}/_all_docs?include_docs=true`, { headers: auth });
    if (!res.ok) throw new Error(`could not enumerate ${db}: ${res.status}`);
    const rows = ((await res.json()) as any).rows;
    const doc = rows.map((row: any) => row.doc).find((candidate: any) => candidate?.path === path);
    if (!doc) throw new Error(`could not find raw file document for ${path}`);
    return doc;
}

async function injectSiblingConflicts(db: string, path: string): Promise<void> {
    const current = await rawFileDoc(db, path);
    const separator = current._rev.indexOf("-");
    const generation = Number(current._rev.slice(0, separator));
    const parentHash = current._rev.slice(separator + 1);
    const childGeneration = generation + 1;
    const branches = ["a".repeat(32), "f".repeat(32)].map((hash) => ({
        ...current,
        _rev: `${childGeneration}-${hash}`,
        _revisions: { start: childGeneration, ids: [hash, parentHash] },
        mtime: Date.now(),
    }));
    const res = await fetch(`${base.couchdbUrl}/${db}/_bulk_docs`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ docs: branches, new_edits: false }),
    });
    if (!res.ok) throw new Error(`could not inject conflicts: ${res.status}`);
}

try {
// UUID-scoped names make setup create-only and prevent collisions with real vaults.
for (const db of Object.values(databases)) {
    const res = await fetch(`${base.couchdbUrl}/${db}`, { method: "PUT", headers: auth });
    if (res.status !== 201) throw new Error(`could not create unique test database: ${res.status}`);
}

// --- Versioned single-note contract against a real CouchDB ---
step("Versioned winner-CAS contract");
{
    const v = new Vault({ ...base, database: databases.core, obfuscatePaths: false });
    await v.init();
    const exact = encoder.encode("---\r\ntitle: Exact\r\n---\r\nbody");
    const created = await v.createVersioned("Core/exact.md", exact);
    if (created.status !== "ok" || !created.note) throw new Error("create did not return a note");
    assert.match(created.note.version, /^nv1\./);
    const winner = (created.note.backendState as { winnerRevision: string }).winnerRevision;
    assert.equal(created.note.version.includes(winner), false, "opaque version must not expose the raw CouchDB revision");
    assert.equal(new TextDecoder().decode(created.note.bytes), "---\r\ntitle: Exact\r\n---\r\nbody");

    const duplicate = await v.createVersioned("Core/exact.md", encoder.encode("overwrite"));
    assert.equal(duplicate.status, "conflict");
    assert.equal(duplicate.status === "conflict" && duplicate.code, "DESTINATION_EXISTS");

    const staleVersion = created.note.version;
    assert.equal(await v.writeNote("Core/exact.md", "external"), true);
    const stale = await v.replaceVersioned("Core/exact.md", staleVersion, encoder.encode("bad"));
    assert.equal(stale.status, "conflict");
    assert.equal(stale.status === "conflict" && stale.code, "STALE_VERSION");

    const current = await v.readVersioned("Core/exact.md");
    if (current.status !== "ok") throw new Error("fresh read failed");
    const replaced = await v.replaceVersioned("Core/exact.md", current.note.version, encoder.encode("replacement"));
    assert.equal(replaced.status, "ok");
    assert.equal(await v.readNote("Core/exact.md"), "replacement");

    const occupied = await v.createVersioned("Core/occupied.md", encoder.encode("keep"));
    assert.equal(occupied.status, "ok");
    const forMove = await v.readVersioned("Core/exact.md");
    if (forMove.status !== "ok") throw new Error("move source read failed");
    const blockedMove = await v.moveVersioned("Core/exact.md", "Core/occupied.md", forMove.note.version);
    assert.equal(blockedMove.status, "conflict");
    assert.equal(blockedMove.status === "conflict" && blockedMove.code, "DESTINATION_EXISTS");
    assert.equal(await v.readNote("Core/occupied.md"), "keep");
    assert.equal(await v.readNote("Core/exact.md"), "replacement");

    const moved = await v.moveVersioned("Core/exact.md", "Core/moved.md", forMove.note.version);
    assert.equal(moved.status, "ok");
    assert.deepEqual(moved.effects, [
        { kind: "destination_created", path: "Core/moved.md", completed: true },
        { kind: "source_deleted", path: "Core/exact.md", completed: true },
    ]);
    const movedRead = await v.readVersioned("Core/moved.md");
    if (movedRead.status !== "ok") throw new Error("moved note read failed");
    const deleted = await v.deleteVersioned("Core/moved.md", movedRead.note.version);
    assert.equal(deleted.status, "ok");
    const tombstone = await v.readVersioned("Core/moved.md");
    assert.equal(tombstone.status, "error");
    assert.equal(tombstone.status === "error" && tombstone.code, "RESTORE_REQUIRED");
    const restore = await v.createVersioned("Core/moved.md", encoder.encode("resurrect"));
    assert.equal(restore.status, "error");
    assert.equal(restore.status === "error" && restore.code, "RESTORE_REQUIRED");

    const conflictCreated = await v.createVersioned("Core/conflict.md", encoder.encode("base"));
    if (conflictCreated.status !== "ok" || !conflictCreated.note) throw new Error("conflict seed failed");
    await injectSiblingConflicts(databases.core, "Core/conflict.md");
    const conflicted = await v.readVersioned("Core/conflict.md");
    assert.ok(conflicted.status === "ok" && conflicted.note.conflicts.length > 0);
    if (conflicted.status !== "ok") throw new Error("conflicted read failed");
    const refused = await v.replaceVersioned("Core/conflict.md", conflicted.note.version, encoder.encode("unsafe"));
    assert.equal(refused.status, "conflict");
    assert.equal(refused.status === "conflict" && refused.code, "PRE_EXISTING_CONFLICT");
    await v.close();
    console.log("create/read/replace/move/delete/tombstone/conflict winner-CAS scenarios OK");
}

// --- Seed: obfuscated vault (correct settings) ---
step("Seed obfvault with obfuscatePaths=true");
{
    const v = new Vault({ ...base, database: databases.obfuscated, passphrase, obfuscatePaths: true });
    await v.init();
    assert.equal(await v.writeNote(NOTE_CYRILLIC, "# Тест\nprivet"), true);
    assert.equal(await v.writeNote(NOTE_DAILY, "daily entry"), true);
    assert.equal(await v.readNote(NOTE_CYRILLIC), "# Тест\nprivet");
    await v.close();
    console.log("seeded 2 notes, read-back OK");
}

// Confirm the raw _ids really are obfuscated (f: prefix)
step("Raw doc IDs in obfvault");
{
    const rows = await rawAllDocIds(databases.obfuscated);
    console.log(rows.join("\n"));
    const fileIds = rows.filter((id) => id.startsWith("f:"));
    assert.equal(fileIds.length, 2, "expected exactly 2 f:-prefixed file docs");
}

// --- Test 2: issue #10 repro — obfuscated vault, flag off ---
step("Test 2: open obfvault with obfuscatePaths=false (expect warning + auto-enable)");
{
    const v = new Vault({ ...base, database: databases.obfuscated, passphrase, obfuscatePaths: false });
    await v.init();
    const content = await v.readNote(NOTE_CYRILLIC);
    assert.equal(content, "# Тест\nprivet", "read_note must resolve after auto-correction");
    const listed = await v.listNotes();
    assert.deepEqual(listed.sort(), [NOTE_DAILY, NOTE_CYRILLIC].sort());
    assert.equal(await v.writeNote("Inbox/written-under-wrong-flag.md", "hello"), true);
    await v.close();
    console.log("read_note + list_notes + create_note-compatible writes OK under corrected settings");
}

// The write from Test 2 must have produced an obfuscated doc (what LiveSync
// clients expect), not a plaintext-id doc they'd ignore (issue #4).
step("Test 2b: write under corrected settings produced an f: doc");
{
    const rows = await rawAllDocIds(databases.obfuscated);
    const fileIds = rows.filter((id) => id.startsWith("f:"));
    const plaintextIds = rows.filter((id) => id.includes(".md"));
    console.log(`f: docs: ${fileIds.length}, plaintext-path docs: ${plaintextIds.length}`);
    assert.equal(fileIds.length, 3, "expected 3 f:-prefixed file docs after write");
    assert.equal(plaintextIds.length, 0, "no plaintext-id file docs may exist");
}

// --- Seed: plain vault (E2EE on, obfuscation off) ---
step("Seed plainvault with obfuscatePaths=false");
{
    const v = new Vault({ ...base, database: databases.plain, passphrase, obfuscatePaths: false });
    await v.init();
    assert.equal(await v.writeNote(NOTE_DAILY, "plain vault daily"), true);
    assert.equal(await v.writeNote("Notes/hello.md", "world"), true);
    await v.close();
    console.log("seeded 2 notes");
}

// --- Test 3: reverse mismatch — plain vault, flag on ---
step("Test 3: open plainvault with obfuscatePaths=true (expect warning + auto-disable)");
{
    const v = new Vault({ ...base, database: databases.plain, passphrase, obfuscatePaths: true });
    await v.init();
    assert.equal(await v.readNote(NOTE_DAILY), "plain vault daily");
    assert.equal(await v.readNote("Notes/hello.md"), "world");
    await v.close();
    console.log("read_note OK under corrected settings");
}

// --- Test 4: obfuscated vault, no passphrase → fail fast ---
step("Test 4: open obfvault without passphrase (expect init to throw)");
{
    const v = new Vault({ ...base, database: databases.obfuscated, passphrase: undefined, obfuscatePaths: false });
    await assert.rejects(
        () => v.init(),
        (err: Error) => err.message.includes("COUCHDB_PASSPHRASE"),
        "init must fail fast with a passphrase error",
    );
    console.log("init rejected with:", (await v.init().catch((e: Error) => e.message)));
}

// --- Control: matching settings produce no correction ---
step("Control: open obfvault with obfuscatePaths=true (expect NO warning)");
{
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); origWarn(...a); };
    const v = new Vault({ ...base, database: databases.obfuscated, passphrase, obfuscatePaths: true });
    await v.init();
    console.warn = origWarn;
    assert.equal(await v.readNote(NOTE_CYRILLIC), "# Тест\nprivet");
    const mismatchWarnings = warnings.filter((w) => w.includes("COUCHDB_OBFUSCATE_PROPERTIES"));
    assert.equal(mismatchWarnings.length, 0, "no mismatch warning expected when settings match");
    await v.close();
    console.log("no warning, reads OK");
}

console.log("\nAll obfuscation-detection scenarios passed.");
} finally {
    for (const db of Object.values(databases)) {
        await fetch(`${base.couchdbUrl}/${db}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
}
process.exit(0);
