import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalVault } from "./vault-local.js";
import { Vault } from "./vault.js";
import { SearchIndex } from "./search.js";
import { FullTextIndex } from "./full-text-search.js";
import { registerTools } from "./tools.js";
import type { ViteMCP } from "@vitemcp/server";

for (const local of [false, true]) it(`root-only fallback through ${local ? "filesystem" : "CouchDB enumeration"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "listing-"));
    const paths = ["root.md", "(root)/child.md", "parent/deep/child.md"];
    // Exercise the real CouchDB listing methods with an in-process document feed.
    const vault = local ? new LocalVault(dir) : Object.assign(Object.create(Vault.prototype), {
        manipulator: { async *enumerateAllNormalDocs() {
            for (const path of paths) yield { path, mtime: 1 };
            yield { path: "deleted.md", deleted: true };
            yield { path: "asset.png" };
        } },
    }) as Vault;
    try {
        if (local) for (const path of paths) await vault.writeNote(path, "body");
        assert.deepEqual(await vault.listNotes(""), ["root.md"]);
        assert.equal((await vault.listNotes()).length, 3);
        assert.deepEqual(await vault.listNotes("parent"), ["parent/deep/child.md"]);
        assert.deepEqual(await vault.listNotes("(root)"), ["(root)/child.md"]);
        for (const sqlite of [false, true]) {
            const index = new SearchIndex(sqlite ? await FullTextIndex.open(":memory:") : undefined);
            try {
                index.update("indexed/nested.md", "body");
                const tools = new Map<string, any>();
                registerTools({ addTool: (tool: any) => { tools.set(tool.name, tool); return tool; } } as unknown as ViteMCP, vault, index, "Test");
                const result = (await tools.get("list_notes").execute({ folder: "" })).structuredContent.result;
                assert.equal(result.source, "vault");
                assert.deepEqual(result.entries.map((n: any) => n.path), ["root.md"]);
            } finally { index.close(); }
        }
    } finally { await rm(dir, { recursive: true, force: true }); }
});
