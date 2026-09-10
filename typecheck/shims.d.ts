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
