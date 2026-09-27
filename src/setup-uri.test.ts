import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { decrypt } from "octagonal-wheels/encryption/encryption";

// deploy/setup.sh generates the passphrase, shows it to the operator and passes
// it to this script for each URI. The script's contract is that the URI it
// prints imports with that passphrase and that it never prints the passphrase.
const SCRIPT = fileURLToPath(new URL("../deploy/generate-setup-uri.mjs", import.meta.url));
const run = promisify(execFile);

const baseEnv = {
    PATH: process.env.PATH,
    hostname: "https://example.fly.dev:5984",
    username: "livesync",
    password: "couch-password",
    database: "obsidian",
};

describe("deploy/generate-setup-uri.mjs", () => {
    it("prints only a setup URI that decrypts with the given passphrase", async () => {
        const uriPassphrase = "0123456789abcdef0123456789abcdef";
        const { stdout } = await run(process.execPath, [SCRIPT], {
            env: { ...baseEnv, uri_passphrase: uriPassphrase },
        });

        const lines = stdout.trimEnd().split("\n");
        assert.equal(lines.length, 1);
        assert.ok(!stdout.includes(uriPassphrase));

        const prefix = "obsidian://setuplivesync?settings=";
        assert.ok(lines[0].startsWith(prefix));
        const settings = decodeURIComponent(lines[0].slice(prefix.length));
        const conf = JSON.parse(await decrypt(settings, uriPassphrase, false));
        assert.equal(conf.couchDB_URI, baseEnv.hostname);
        assert.equal(conf.couchDB_USER, baseEnv.username);
        assert.equal(conf.couchDB_PASSWORD, baseEnv.password);
        assert.equal(conf.couchDB_DBNAME, baseEnv.database);
        assert.equal(conf.encrypt, false);
    });

    it("exits without output when uri_passphrase is missing", async () => {
        await assert.rejects(run(process.execPath, [SCRIPT], { env: baseEnv }), (err: any) => {
            assert.equal(err.code, 1);
            assert.equal(err.stdout, "");
            return true;
        });
    });
});
