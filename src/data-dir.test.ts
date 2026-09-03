import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { dataDirPermissionMessage, ensureDataDirWritable } from "./data-dir.js";

test("dataDirPermissionMessage: names the path, the uids, and the chown fix", () => {
    const message = dataDirPermissionMessage({
        path: "/data", code: "EACCES", processUid: 1000, ownerUid: 0, ownerPath: "/data",
    });
    assert.match(message, /DATA_DIR "\/data"/);
    assert.match(message, /running as uid 1000/);
    assert.match(message, /owned by uid 0/);
    assert.match(message, /chown -R 1000:1000/);
});

test("dataDirPermissionMessage: reports the inspected ancestor when the path is missing", () => {
    const message = dataDirPermissionMessage({
        path: "/data/sub", code: "EACCES", processUid: 1000, ownerUid: 0, ownerPath: "/data",
    });
    assert.match(message, /owned by uid 0 \(on \/data\)/);
});

test("dataDirPermissionMessage: a read-only filesystem gets its own remedy", () => {
    const message = dataDirPermissionMessage({ path: "/data", code: "EROFS", processUid: 1000 });
    assert.match(message, /read-only filesystem/);
    assert.doesNotMatch(message, /chown/);
});

test("ensureDataDirWritable: creates a missing directory with owner-only permissions", async () => {
    const base = await mkdtemp(join(tmpdir(), "data-dir-test-"));
    try {
        const target = join(base, "nested", "data");
        await ensureDataDirWritable(target);
        const info = await stat(target);
        assert.equal(info.isDirectory(), true);
        if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o700);
        // Re-running against the existing directory must stay a no-op.
        await ensureDataDirWritable(target);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

// root ignores the mode bits, so the denial can only be exercised unprivileged.
const unprivileged = process.platform !== "win32" && process.getuid?.() !== 0;
test("ensureDataDirWritable: an unwritable directory raises the actionable error", { skip: !unprivileged }, async () => {
    const base = await mkdtemp(join(tmpdir(), "data-dir-test-"));
    try {
        await chmod(base, 0o500);
        await assert.rejects(
            ensureDataDirWritable(join(base, "data")),
            (error: Error) => {
                assert.match(error.message, /Cannot write to DATA_DIR/);
                // The temp dir is owned by the test process, so this is the mode branch.
                assert.match(error.message, /chmod u\+rwx/);
                assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
                return true;
            },
        );
    } finally {
        await chmod(base, 0o700);
        await rm(base, { recursive: true, force: true });
    }
});

test("dataDirPermissionMessage: same-owner denial points at the mode, not ownership", () => {
    const message = dataDirPermissionMessage({
        path: "/data/sub", code: "EACCES", processUid: 1000, ownerUid: 1000, ownerPath: "/data",
    });
    assert.match(message, /already owns it \(on \/data\)/);
    assert.match(message, /chmod u\+rwx \/data/);
    assert.doesNotMatch(message, /chown/);
});
