import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyNoteEdit } from "./note-edit.js";
import { isOpaqueNoteVersion } from "./note-version.js";
import { structuredNoteResultSchema, schemaVersion, recovery } from "./note-contract.js";
import { LocalVault } from "./vault-local.js";

const directories: string[] = [];
async function vault() {
    const root = await mkdtemp(join(tmpdir(), "note-core-"));
    directories.push(root);
    return { root, backend: new LocalVault(root) };
}
afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("exact edit transformations", () => {
    it("never inserts a separator or normalises CRLF", () => {
        assert.deepEqual(applyNoteEdit("a\r\n", "append", "b"), { ok: true, content: "a\r\nb", replacements: 0 });
        assert.deepEqual(applyNoteEdit("---\r\nx: y\r\n---\r\nbody", "prepend_body", "top"), {
            ok: true, content: "---\r\nx: y\r\n---\r\ntopbody", replacements: 0,
        });
        assert.deepEqual(applyNoteEdit("old\n", "replace_all", "new\r\n"), { ok: true, content: "new\r\n", replacements: 1 });
    });

    it("replace_once rejects zero and multiple literal matches", () => {
        assert.deepEqual(applyNoteEdit("abc", "replace_once", "x", "z"), { ok: false, code: "LITERAL_NOT_FOUND", matches: 0 });
        assert.deepEqual(applyNoteEdit("a a", "replace_once", "x", "a"), { ok: false, code: "LITERAL_AMBIGUOUS", matches: 2 });
        assert.deepEqual(applyNoteEdit("abc", "replace_once", "X", "b"), { ok: true, content: "aXc", replacements: 1 });
        assert.deepEqual(applyNoteEdit("aaa", "replace_once", "X", "aa"), { ok: false, code: "LITERAL_AMBIGUOUS", matches: 2 });
    });
});

describe("local versioned backend", () => {
    it("creates only when absent and returns opaque versions", async () => {
        const { backend } = await vault();
        const first = await backend.createVersioned("note.md", new TextEncoder().encode(""));
        assert.equal(first.status, "ok");
        assert.ok(first.status === "ok" && first.note && isOpaqueNoteVersion(first.note.version));
        const second = await backend.createVersioned("note.md", new TextEncoder().encode("overwrite"));
        assert.equal(second.status, "conflict");
        assert.equal(await backend.readNote("note.md"), "");
    });

    it("keeps the internal backend byte-capable", async () => {
        const { backend } = await vault();
        const bytes = Uint8Array.from([0, 255, 13, 10]);
        const created = await backend.createVersioned("binary.md", bytes);
        assert.equal(created.status, "ok");
        const read = await backend.readVersioned("binary.md");
        assert.equal(read.status, "ok");
        assert.deepEqual(read.status === "ok" && Array.from(read.note.bytes), Array.from(bytes));
    });

    it("rejects stale and cross-backend versions, including same-content rewrites", async () => {
        const one = await vault();
        const two = await vault();
        await one.backend.writeNote("note.md", "same");
        await two.backend.writeNote("note.md", "same");
        const readOne = await one.backend.readVersioned("note.md");
        const readTwo = await two.backend.readVersioned("note.md");
        assert.equal(readOne.status, "ok");
        assert.equal(readTwo.status, "ok");
        if (readOne.status !== "ok" || readTwo.status !== "ok") return;
        assert.notEqual(readOne.note.version, readTwo.note.version);
        const replay = await two.backend.replaceVersioned("note.md", readOne.note.version, new TextEncoder().encode("bad"));
        assert.equal(replay.status, "conflict");
        const rewritten = await one.backend.replaceVersioned("note.md", readOne.note.version, new TextEncoder().encode("same"));
        assert.equal(rewritten.status, "ok");
        assert.ok(rewritten.status === "ok" && rewritten.note);
        assert.notEqual(rewritten.status === "ok" && rewritten.note?.version, readOne.note.version);
    });

    it("serialises writers so only one mutation can use a version", async () => {
        const { backend } = await vault();
        await backend.writeNote("race.md", "v1");
        const read = await backend.readVersioned("race.md");
        assert.equal(read.status, "ok");
        if (read.status !== "ok") return;
        const outcomes = await Promise.all([
            backend.replaceVersioned("race.md", read.note.version, new TextEncoder().encode("left")),
            backend.replaceVersioned("race.md", read.note.version, new TextEncoder().encode("right")),
        ]);
        assert.deepEqual(outcomes.map((value) => value.status).sort(), ["conflict", "ok"]);
    });

    it("never overwrites a move destination", async () => {
        const { root, backend } = await vault();
        await writeFile(join(root, "from.md"), "source");
        await writeFile(join(root, "to.md"), "destination");
        const read = await backend.readVersioned("from.md");
        assert.equal(read.status, "ok");
        if (read.status !== "ok") return;
        const moved = await backend.moveVersioned("from.md", "to.md", read.note.version);
        assert.equal(moved.status, "conflict");
        assert.equal(await readFile(join(root, "to.md"), "utf8"), "destination");
        assert.equal(await readFile(join(root, "from.md"), "utf8"), "source");
    });

    it("reports filesystem birth time as created and preserves mode across replace and move", async () => {
        const { root, backend } = await vault();
        const source = join(root, "from.md");
        await writeFile(source, "source");
        await new Promise((resolve) => setTimeout(resolve, 20));
        await chmod(source, 0o640);
        const sourceStat = await stat(source, { bigint: true });
        const expectedCreated = Number((sourceStat.birthtimeNs > 0n ? sourceStat.birthtimeNs : sourceStat.ctimeNs) / 1_000_000n);
        const initial = await backend.readVersioned("from.md");
        assert.equal(initial.status, "ok");
        if (initial.status !== "ok") return;
        assert.equal(initial.note.ctime, expectedCreated);

        const replaced = await backend.replaceVersioned("from.md", initial.note.version, new TextEncoder().encode("updated"));
        assert.equal(replaced.status, "ok");
        assert.equal((await stat(source)).mode & 0o777, 0o640);
        if (replaced.status !== "ok" || !replaced.note) return;
        const moved = await backend.moveVersioned("from.md", "to.md", replaced.note.version);
        assert.equal(moved.status, "ok");
        assert.equal((await stat(join(root, "to.md"))).mode & 0o777, 0o640);
    });

    it("rejects absent targets below a symlinked parent outside the vault", async () => {
        const inside = await vault();
        const outside = await vault();
        await symlink(outside.root, join(inside.root, "escape"), "dir");
        const result = await inside.backend.createVersioned("escape/note.md", new TextEncoder().encode("secret"));
        assert.equal(result.status, "error");
        assert.equal(result.status === "error" && result.code, "INVALID_PATH");
    });

    it("accepts only canonical vault-relative Markdown paths", async () => {
        const { backend } = await vault();
        for (const path of ["note.txt", "folder\\note.md", "/note.md", "a/../note.md", "a//note.md"]) {
            const result = await backend.createVersioned(path, new Uint8Array());
            assert.equal(result.status, "error", path);
            assert.equal(result.status === "error" && result.code, "INVALID_PATH", path);
        }
    });
});

describe("strict result union", () => {
    it("rejects fields that do not belong to a status", () => {
        const invalid = {
            schemaVersion, status: "error", error: { code: "NOTE_NOT_FOUND", message: "missing" },
            recovery: recovery("change_request", "choose another path"), effects: [],
        };
        assert.equal(structuredNoteResultSchema.safeParse(invalid).success, false);
    });
});
