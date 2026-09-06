import { jsonSchemaAdapter, type JsonSchemaObject } from "fastmcp";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const schemaVersion = "0.9.0" as const;
export const recoveryStrategySchema = z.enum(["retry_same", "read_then_retry", "change_request", "manual_reconcile", "none"]);
export const errorCodeSchema = z.enum([
    "INVALID_PATH", "NOTE_NOT_FOUND", "WRITE_DENIED", "STALE_VERSION",
    "PRE_EXISTING_CONFLICT", "DESTINATION_EXISTS", "RESTORE_REQUIRED",
    "LITERAL_NOT_FOUND", "LITERAL_AMBIGUOUS", "BACKEND_UNAVAILABLE", "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type RecoveryStrategy = z.infer<typeof recoveryStrategySchema>;

export const recoverySchema = z.object({ strategy: recoveryStrategySchema, guidance: z.string() }).strict();
export const errorDetailSchema = z.object({ code: errorCodeSchema, message: z.string() }).strict();
export const effectSchema = z.object({
    kind: z.enum(["destination_created", "source_deleted", "note_created", "note_updated", "note_deleted", "index_updated"]),
    path: z.string(),
    completed: z.boolean(),
}).strict();
const timestampsSchema = z.object({ created: z.string(), modified: z.string() }).strict();
const conflictStateSchema = z.object({ hasConflicts: z.boolean(), leafCount: z.number().int().positive() }).strict();
const noteBaseSchema = z.object({
    kind: z.literal("note"),
    path: z.string(),
    version: z.string(),
    size: z.number().int().nonnegative(),
    timestamps: timestampsSchema,
    frontmatter: z.record(z.string()),
    tags: z.array(z.string()),
    outgoingLinks: z.array(z.string()),
    conflict: conflictStateSchema,
    concurrency: z.enum(["best_effort", "strict_winner_cas"]),
    deepLink: z.string(),
});
export const noteReadResultSchema = noteBaseSchema.extend({ markdown: z.string() }).strict();
export const noteMetadataResultSchema = noteBaseSchema.extend({
    backlinks: z.array(z.string()),
    indexFreshness: z.enum(["current", "building", "catching_up", "stale"]),
}).strict();
export const mutationResultSchema = z.object({
    kind: z.literal("mutation"),
    operation: z.enum(["create", "edit", "delete", "move"]),
    path: z.string(),
    destinationPath: z.string().optional(),
    oldVersion: z.string().optional(),
    newVersion: z.string().optional(),
    replacements: z.number().int().nonnegative().optional(),
    concurrency: z.enum(["best_effort", "strict_winner_cas"]),
    indexFreshness: z.enum(["current", "stale"]),
    deepLink: z.string().optional(),
}).strict();
const resultSchema = z.union([noteReadResultSchema, noteMetadataResultSchema, mutationResultSchema]);

export const structuredNoteResultSchema = z.discriminatedUnion("status", [
    z.object({ schemaVersion: z.literal(schemaVersion), status: z.literal("ok"), result: resultSchema, effects: z.array(effectSchema), warnings: z.array(z.string()), recovery: recoverySchema }).strict(),
    z.object({ schemaVersion: z.literal(schemaVersion), status: z.literal("conflict"), error: errorDetailSchema, effects: z.array(effectSchema), recovery: recoverySchema }).strict(),
    z.object({ schemaVersion: z.literal(schemaVersion), status: z.literal("committed_with_conflict"), result: mutationResultSchema, effects: z.array(effectSchema), warning: z.string(), recovery: recoverySchema }).strict(),
    z.object({ schemaVersion: z.literal(schemaVersion), status: z.literal("partial"), effects: z.array(effectSchema), error: errorDetailSchema, warning: z.string(), recovery: recoverySchema }).strict(),
    z.object({ schemaVersion: z.literal(schemaVersion), status: z.literal("indeterminate"), effects: z.array(effectSchema), error: errorDetailSchema, warning: z.string(), recovery: recoverySchema }).strict(),
    z.object({ schemaVersion: z.literal(schemaVersion), status: z.literal("error"), error: errorDetailSchema, recovery: recoverySchema }).strict(),
]);
export type StructuredNoteResult = z.infer<typeof structuredNoteResultSchema>;

// MCP requires an object-root output schema. Keep the exact discriminated union
// visible to clients while adding the required root type alongside `anyOf`.
const unionJsonSchema = zodToJsonSchema(structuredNoteResultSchema, {
    $refStrategy: "none",
}) as JsonSchemaObject;
export const structuredNoteOutputSchema = jsonSchemaAdapter({
    ...unionJsonSchema,
    type: "object",
});

export function recovery(strategy: RecoveryStrategy, guidance: string) {
    return { strategy, guidance };
}
export function domainError(code: ErrorCode, message: string, strategy: RecoveryStrategy, guidance: string): StructuredNoteResult {
    return { schemaVersion, status: "error", error: { code, message }, recovery: recovery(strategy, guidance) };
}
export function renderStructuredResult(value: StructuredNoteResult): string {
    if (value.status === "ok") {
        if (value.result.kind === "note" && "markdown" in value.result) return value.result.markdown + "\n\n[Open in Obsidian](" + value.result.deepLink + ")";
        if (value.result.kind === "note") return "Metadata: " + value.result.path + "\nVersion: " + value.result.version + "\n[Open in Obsidian](" + value.result.deepLink + ")";
        const destination = value.result.destinationPath ? " -> " + value.result.destinationPath : "";
        const warnings = value.warnings.length ? "\nWarning: " + value.warnings.join(" ") : "";
        const link = value.result.deepLink ? "\n[Open in Obsidian](" + value.result.deepLink + ")" : "";
        return value.result.operation + " committed: " + value.result.path + destination + warnings + link;
    }
    if (value.status === "committed_with_conflict") return "Committed, but reconciliation is required: " + value.warning + "\n" + value.recovery.guidance;
    if (value.status === "partial" || value.status === "indeterminate") {
        const effects = value.effects.map((effect) => "- " + (effect.completed ? "completed" : "not confirmed") + ": " + effect.kind + " (" + effect.path + ")").join("\n");
        return value.recovery.guidance + "\n" + value.warning + "\nKnown effects:\n" + effects;
    }
    return value.recovery.guidance + "\n" + value.error.code + ": " + value.error.message;
}
export function toToolResult(value: StructuredNoteResult) {
    const validated = structuredNoteResultSchema.parse(value);
    return {
        content: [{ type: "text" as const, text: renderStructuredResult(validated) }],
        structuredContent: validated,
        isError: validated.status === "error" || validated.status === "conflict" || validated.status === "partial" || validated.status === "indeterminate",
    };
}
