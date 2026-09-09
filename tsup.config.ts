import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

export default defineConfig({
    entry: ["src/main.ts"],
    format: ["esm"],
    target: "node24",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
    define: {
        "process.env.npm_package_version": JSON.stringify(pkg.version),
    },
});
