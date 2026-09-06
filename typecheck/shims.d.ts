// Type-check-only shims for `pnpm typecheck` (tsconfig.typecheck.json).
//
// These declarations are NOT used by the runtime build: tsup/esbuild resolves
// the real modules (see tsup.config.ts). They exist so `tsc --noEmit` can check
// src/ without pulling in modules that only ever resolve through the bundler.
//
// This file must stay a *script* (no top-level import/export) so the `declare
// module` blocks below register as ambient module declarations.

// --- vendored livesync-commonlib (submodule) --------------------------------
// The submodule is compiled by esbuild, never by tsc, and does not type-check
// under our strict config. Treat everything reached through the @lib/* alias as
// an opaque `any` boundary. The wildcard covers value imports; names used in
// *type* position need an explicit `any` export (adding a new such import to
// src/ means adding it here too).
declare module "@lib/*";

declare module "@lib/API/DirectFileManipulator" {
    export class DirectFileManipulator {
        constructor(...args: any[]);
        [key: string]: any;
    }
    export type DirectFileManipulatorOptions = any;
}

declare module "@lib/API/DirectFileManipulatorV2" {
    export type MetaEntry = any;
}

declare module "@lib/common/types" {
    export type FilePathWithPrefix = any;
}

// --- better-sqlite3-multiple-ciphers ----------------------------------------
// API-compatible fork of better-sqlite3 that ships no type declarations. Mirror
// the upstream @types/better-sqlite3 `export =` shape (constructor value +
// namespace of types, so `Database.Database` / `Database.Statement` resolve),
// with the instance type extended by the cipher methods the fork adds
// (key/rekey).
declare module "better-sqlite3-multiple-ciphers" {
    import Base = require("better-sqlite3");

    interface CipherDatabase extends Base.Database {
        key(key: Buffer | string): void;
        rekey(key: Buffer | string): void;
    }

    const Database: {
        new (filename?: string | Buffer, options?: Base.Options): CipherDatabase;
        (filename?: string, options?: Base.Options): CipherDatabase;
    };

    namespace Database {
        export type Database = CipherDatabase;
        export type Statement<B extends unknown[] | {} = unknown[], R = unknown> = Base.Statement<B, R>;
    }

    export = Database;
}
