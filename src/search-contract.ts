import { MAX_SEARCH_LIMIT } from "./search-limits.js";
import { jsonSchemaAdapter, type JsonSchemaObject } from "@vitemcp/server";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const searchSchemaVersion = "1.0.0" as const;
export const searchHitSchema = z.object({
    path: z.string(),
    rank: z.number().finite().describe("Existing RRF score, higher first; not an ordinal position."),
    matchedBy: z.enum(["exact", "metadata", "passage"]).describe("Lane supplying the primary snippet, not every ranking contribution."),
    snippet: z.string().describe("Indexed excerpt with Markdown ** match highlights and ellipses."),
    heading: z.string().optional(),
    breadcrumb: z.string().optional(),
    modified: z.string().datetime().nullable().describe("Indexed modification time as ISO UTC, or null when unavailable."),
    deepLink: z.string(),
    title: z.string().describe("Indexed first H1 with filename fallback; not YAML title."),
    aliases: z.array(z.string()),
    tags: z.array(z.string()),
}).strict();
const envelopeSchema = z.discriminatedUnion("status", [
    z.object({
        schemaVersion: z.literal(searchSchemaVersion),
        status: z.literal("ok"),
        result: z.object({ hits: z.array(searchHitSchema).max(MAX_SEARCH_LIMIT), returnedCount: z.number().int().min(0).max(MAX_SEARCH_LIMIT).describe("Number of returned hits, not total matches. Missing hits do not prove absence.") }).strict(),
        notices: z.array(z.string()).describe("Existing index-status notices; no additional freshness guarantee."),
    }).strict(),
    z.object({
        schemaVersion: z.literal(searchSchemaVersion),
        status: z.literal("error"),
        error: z.object({
            code: z.enum(["INVALID_SEARCH_INPUT", "SEARCH_FAILED"]),
            message: z.string(),
        }).strict(),
    }).strict(),
]);
export const structuredSearchResultSchema = envelopeSchema.refine(
    (value) => value.status !== "ok" || value.result.returnedCount === value.result.hits.length,
    { message: "returnedCount must equal hits.length" },
);
export type StructuredSearchResult = z.infer<typeof structuredSearchResultSchema>;
// JSON Schema cannot express the cross-field count equality; validate it above.
export const structuredSearchOutputSchema = jsonSchemaAdapter({
    ...zodToJsonSchema(envelopeSchema, { $refStrategy: "none" }) as JsonSchemaObject,
    type: "object",
});

export function searchError(code: "INVALID_SEARCH_INPUT" | "SEARCH_FAILED"): StructuredSearchResult {
    return {
        schemaVersion: searchSchemaVersion, status: "error",
        error: { code, message: code === "INVALID_SEARCH_INPUT"
            ? "Invalid search input. Use a query containing letters or numbers and a valid ISO modified_after date."
            : "Search could not be completed. Try again later." },
    };
}
export function toSearchToolResult(value: StructuredSearchResult) {
    const validated = structuredSearchResultSchema.parse(value);
    let text: string;
    if (validated.status === "error") text = `${validated.error.code}: ${validated.error.message}`;
    else {
        const rendered = validated.result.hits.map((hit) => {
            const date = hit.modified ? ` (${hit.modified.slice(0, 10)})` : "";
            const location = hit.breadcrumb ? ` — ${hit.breadcrumb}` : "";
            const snippet = hit.snippet ? `\n  ${hit.snippet}` : "";
            return `- [${hit.path}](${hit.deepLink})${date}${location}${snippet}`;
        }).join("\n") || "No notes found matching the search.";
        text = [...validated.notices, rendered].join("\n\n");
    }
    return {
        content: [{ type: "text" as const, text }],
        structuredContent: validated,
        isError: validated.status === "error",
    };
}
