// DATA_DIR preflight.
// v0.8.1 started running the container as the unprivileged "node" user, so a
// data volume created by an earlier root-running image is no longer writable.
// Without this check the first write is a raw EACCES stack from deep inside
// SQLite or the auth persister, which does not name the cause or the fix.

import { constants } from "fs";
import { access, mkdir, stat } from "fs/promises";
import { dirname } from "path";

export interface DataDirPermissionContext {
    /** Configured DATA_DIR (or its default). */
    path: string;
    /** Errno from the failed mkdir/access. */
    code?: string;
    /** uid of the running process, when the platform reports one. */
    processUid?: number;
    /** uid owning `path`, or its nearest existing ancestor. */
    ownerUid?: number;
    /** The path `ownerUid` describes, when it is an ancestor rather than `path`. */
    ownerPath?: string;
}

/** Explain an unwritable data directory in terms of the fix, not the syscall. */
export function dataDirPermissionMessage(context: DataDirPermissionContext): string {
    const { path, code, processUid, ownerUid, ownerPath } = context;
    if (code === "EROFS") {
        return `DATA_DIR "${path}" is on a read-only filesystem. The search index and auth tokens need a writable directory: mount a volume (or tmpfs) at that path, or point DATA_DIR somewhere writable.`;
    }
    const running = processUid === undefined ? "" : ` (running as uid ${processUid})`;
    const inspected = ownerPath && ownerPath !== path ? ` (on ${ownerPath})` : "";
    const owner = ownerUid === undefined ? "" : ` It is owned by uid ${ownerUid}${inspected}.`;
    if (ownerUid !== undefined && ownerUid === processUid) {
        // Same owner, still denied: the directory mode is the problem, not a volume handed over by an earlier root-running image.
        return `Cannot write to DATA_DIR "${path}"${running}. This process already owns it${inspected}, so its permissions are what deny the write: run "chmod u+rwx ${ownerPath ?? path}", or set DATA_DIR to a writable path.`;
    }
    return [
        `Cannot write to DATA_DIR "${path}"${running}.${owner}`,
        `Since v0.8.1 the container runs as the unprivileged "node" user (uid 1000), so a data volume created by an earlier root-running image is not writable. Fix the ownership once, then restart:`,
        `  Docker named volume:  docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data`,
        `  Bind mount:           sudo chown -R 1000:1000 <host-path>`,
        `  Fly.io machine:       fly ssh console -C "chown -R 1000:1000 /data"`,
        `Or set DATA_DIR to a path this process can write, or run the container as the uid that owns the volume.`,
    ].join("\n");
}

/** uid of `path`, falling back to the nearest existing ancestor. */
async function describeOwner(path: string): Promise<{ ownerUid?: number; ownerPath?: string }> {
    let current = path;
    for (;;) {
        try {
            return { ownerUid: (await stat(current)).uid, ownerPath: current };
        } catch {
            const parent = dirname(current);
            if (parent === current) return {};
            current = parent;
        }
    }
}

/**
 * Create the data directory if needed and confirm this process can write into it.
 * Throws an actionable error on a permission failure; other errors pass through.
 */
export async function ensureDataDirWritable(path: string): Promise<void> {
    try {
        await mkdir(path, { recursive: true, mode: 0o700 });
        // mkdir is a no-op on an existing directory, so probe the permission itself.
        await access(path, constants.W_OK | constants.X_OK);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw error;
        const message = dataDirPermissionMessage({
            path,
            code,
            processUid: process.getuid?.(),
            ...(code === "EROFS" ? {} : await describeOwner(path)),
        });
        throw new Error(message, { cause: error });
    }
}
