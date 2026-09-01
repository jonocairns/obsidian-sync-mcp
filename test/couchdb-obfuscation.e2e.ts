/**
 * E2E test for the COUCHDB_OBFUSCATE_PROPERTIES auto-detection (issues #4,
 * #10) against a real, throwaway CouchDB. Destructive: drops and recreates
 * its two test databases — never point it at a real vault.
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
import { Vault } from "../src/vault.js";

const base = {
    couchdbUrl: process.env.TEST_COUCHDB_URL ?? "http://localhost:5985",
    couchdbUser: process.env.TEST_COUCHDB_USER ?? "admin",
    couchdbPassword: process.env.TEST_COUCHDB_PASSWORD ?? "test",
};
const passphrase = "banana123";

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

// Reset databases so the harness is idempotent across runs.
for (const db of ["obfvault", "plainvault"]) {
    await fetch(`${base.couchdbUrl}/${db}`, { method: "DELETE", headers: auth });
    const res = await fetch(`${base.couchdbUrl}/${db}`, { method: "PUT", headers: auth });
    if (!res.ok) throw new Error(`could not create ${db}: ${res.status}`);
}

// --- Seed: obfuscated vault (correct settings) ---
step("Seed obfvault with obfuscatePaths=true");
{
    const v = new Vault({ ...base, database: "obfvault", passphrase, obfuscatePaths: true });
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
    const rows = await rawAllDocIds("obfvault");
    console.log(rows.join("\n"));
    const fileIds = rows.filter((id) => id.startsWith("f:"));
    assert.equal(fileIds.length, 2, "expected exactly 2 f:-prefixed file docs");
}

// --- Test 2: issue #10 repro — obfuscated vault, flag off ---
step("Test 2: open obfvault with obfuscatePaths=false (expect warning + auto-enable)");
{
    const v = new Vault({ ...base, database: "obfvault", passphrase, obfuscatePaths: false });
    await v.init();
    const content = await v.readNote(NOTE_CYRILLIC);
    assert.equal(content, "# Тест\nprivet", "read_note must resolve after auto-correction");
    const listed = await v.listNotes();
    assert.deepEqual(listed.sort(), [NOTE_DAILY, NOTE_CYRILLIC].sort());
    assert.equal(await v.writeNote("Inbox/written-under-wrong-flag.md", "hello"), true);
    await v.close();
    console.log("read_note + list_notes + write_note OK under corrected settings");
}

// The write from Test 2 must have produced an obfuscated doc (what LiveSync
// clients expect), not a plaintext-id doc they'd ignore (issue #4).
step("Test 2b: write under corrected settings produced an f: doc");
{
    const rows = await rawAllDocIds("obfvault");
    const fileIds = rows.filter((id) => id.startsWith("f:"));
    const plaintextIds = rows.filter((id) => id.includes(".md"));
    console.log(`f: docs: ${fileIds.length}, plaintext-path docs: ${plaintextIds.length}`);
    assert.equal(fileIds.length, 3, "expected 3 f:-prefixed file docs after write");
    assert.equal(plaintextIds.length, 0, "no plaintext-id file docs may exist");
}

// --- Seed: plain vault (E2EE on, obfuscation off) ---
step("Seed plainvault with obfuscatePaths=false");
{
    const v = new Vault({ ...base, database: "plainvault", passphrase, obfuscatePaths: false });
    await v.init();
    assert.equal(await v.writeNote(NOTE_DAILY, "plain vault daily"), true);
    assert.equal(await v.writeNote("Notes/hello.md", "world"), true);
    await v.close();
    console.log("seeded 2 notes");
}

// --- Test 3: reverse mismatch — plain vault, flag on ---
step("Test 3: open plainvault with obfuscatePaths=true (expect warning + auto-disable)");
{
    const v = new Vault({ ...base, database: "plainvault", passphrase, obfuscatePaths: true });
    await v.init();
    assert.equal(await v.readNote(NOTE_DAILY), "plain vault daily");
    assert.equal(await v.readNote("Notes/hello.md"), "world");
    await v.close();
    console.log("read_note OK under corrected settings");
}

// --- Test 4: obfuscated vault, no passphrase → fail fast ---
step("Test 4: open obfvault without passphrase (expect init to throw)");
{
    const v = new Vault({ ...base, database: "obfvault", passphrase: undefined, obfuscatePaths: false });
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
    const v = new Vault({ ...base, database: "obfvault", passphrase, obfuscatePaths: true });
    await v.init();
    console.warn = origWarn;
    assert.equal(await v.readNote(NOTE_CYRILLIC), "# Тест\nprivet");
    const mismatchWarnings = warnings.filter((w) => w.includes("COUCHDB_OBFUSCATE_PROPERTIES"));
    assert.equal(mismatchWarnings.length, 0, "no mismatch warning expected when settings match");
    await v.close();
    console.log("no warning, reads OK");
}

console.log("\nAll obfuscation-detection scenarios passed.");
process.exit(0);
