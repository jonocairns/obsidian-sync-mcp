import { defineConfig } from "tsup";
import path from "path";
import { readFileSync } from "fs";
import type { Plugin } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const livesyncAliases: Plugin = {
    name: "livesync-aliases",
    setup(build) {
        const libSrc = path.resolve("lib/livesync-commonlib/src");
        const stubs = path.resolve("src/stubs");

        // Redirect bgWorker to mock (no web workers in Node)
        build.onResolve({ filter: /bgWorker/ }, () => {
            return { path: path.join(libSrc, "worker/bgWorker.mock.ts") };
        });

        // Redirect pouchdb-browser to pouchdb-http (no IndexedDB in Node)
        build.onResolve({ filter: /pouchdb-browser/ }, () => {
            return { path: path.join(libSrc, "pouchdb/pouchdb-http.ts") };
        });

        // Stub out svelte (UI components we don't need in Node)
        build.onResolve({ filter: /^svelte/ }, () => {
            return { path: path.join(stubs, "svelte.ts") };
        });

        // The @lib/* and @/* aliases are resolved natively from tsconfig
        // `paths` (esbuild reads them), so they need no handler here.
    },
};

export default defineConfig({
    entry: ["src/main.ts"],
    format: ["esm"],
    target: "node24",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    noExternal: [/livesync-commonlib/, /\.\/stubs/],
    banner: {
        js: `#!/usr/bin/env node
// Node polyfills for livesync-commonlib browser globals
if(!("navigator" in globalThis)){globalThis.navigator={language:"en"};}`,
    },
    define: {
        "process.env.npm_package_version": JSON.stringify(pkg.version),
    },
    esbuildPlugins: [livesyncAliases],
});
