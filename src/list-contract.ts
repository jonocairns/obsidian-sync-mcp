import { jsonSchemaAdapter, type JsonSchemaObject } from "@vitemcp/server";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { MAX_LIST_LIMIT } from "./list-limits.js";

export const listSchemaVersion = "1.0.0" as const;
const source = z.enum(["index", "vault"]).describe("Source of candidate paths, not a vault coverage guarantee. Tag filtering always uses indexed metadata.");
const count = z.number().int().nonnegative();
const notes = z.object({
    kind: z.literal("notes"), source,
    entries: z.array(z.object({ path: z.string(), modified: z.string().datetime().nullable(), deepLink: z.string() }).strict()).max(MAX_LIST_LIMIT),
    returnedCount: count.max(MAX_LIST_LIMIT),
    total: count.describe("Exact matching candidate count before truncation, not authoritative vault coverage."),
    truncated: z.boolean(),
}).strict();
const folders = z.object({
    kind: z.literal("folders"), source,
    entries: z.array(z.object({ path: z.string(), directNoteCount: count }).strict()),
}).strict();
const tags = z.object({
    kind: z.literal("tags"), source: z.literal("index"),
    entries: z.array(z.object({ tag: z.string(), count }).strict()),
}).strict();
const error = z.object({
    schemaVersion: z.literal(listSchemaVersion), status: z.literal("error"),
    error: z.object({ code: z.enum(["INVALID_LIST_INPUT", "LIST_FAILED"]), message: z.string() }).strict(),
}).strict();
function envelope<T extends z.ZodTypeAny>(result: T) {
    return z.discriminatedUnion("status", [z.object({
        schemaVersion: z.literal(listSchemaVersion), status: z.literal("ok"), result,
        notices: z.array(z.string()),
    }).strict(), error]);
}
export const structuredListResultSchema = envelope(z.discriminatedUnion("kind", [notes, folders, tags])).refine(
    (v) => v.status !== "ok" || v.result.kind !== "notes" || (
        v.result.returnedCount === v.result.entries.length && v.result.total >= v.result.returnedCount &&
        v.result.truncated === (v.result.returnedCount < v.result.total)
    ), { message: "Inconsistent listing counts" },
);
export type StructuredListResult = z.infer<typeof structuredListResultSchema>;
function outputSchema(result: z.ZodTypeAny) {
    // Cross-field count invariants are enforced by runtime validation above.
    return jsonSchemaAdapter({ ...zodToJsonSchema(envelope(result), { $refStrategy: "none" }) as JsonSchemaObject, type: "object" });
}
export const structuredNotesOutputSchema = outputSchema(notes);
export const structuredFoldersOutputSchema = outputSchema(folders);
export const structuredTagsOutputSchema = outputSchema(tags);
export function listError(code: "INVALID_LIST_INPUT" | "LIST_FAILED"): StructuredListResult {
    return { schemaVersion: listSchemaVersion, status: "error", error: { code, message: code === "INVALID_LIST_INPUT"
        ? "Invalid listing input. Use a valid ISO modified_after date."
        : "Listing could not be completed. Try again later." } };
}
export function toListToolResult(value: StructuredListResult) {
    const validated = structuredListResultSchema.parse(value);
    let text: string;
    if (validated.status === "error") text = `${validated.error.code}: ${validated.error.message}`;
    else {
        const result = validated.result;
        let rendered: string;
        if (result.kind === "notes") {
            rendered = result.entries.map((n) => `- ${n.modified?.slice(0, 16) ?? ""} [${n.path}](${n.deepLink})`).join("\n") || "No notes match these filters.";
            if (result.truncated) rendered += `\n\n... and ${result.total - result.returnedCount} more matching candidates. This listing is truncated; no continuation is available.`;
        } else if (result.kind === "folders") {
            rendered = result.entries.map((f) => `- ${f.path || "(root)"} (${f.directNoteCount} notes)`).join("\n") || "No folders found among listing candidates.";
        } else rendered = result.entries.map((t) => `- #${t.tag} (${t.count} notes)`).join("\n") || "No indexed tags found.";
        text = [...validated.notices, rendered].join("\n\n");
    }
    return { content: [{ type: "text" as const, text }], structuredContent: validated, isError: validated.status === "error" };
}
