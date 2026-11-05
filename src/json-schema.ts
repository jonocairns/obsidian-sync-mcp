import type { JsonSchemaObject } from "@vitemcp/server";
import { z } from "zod";

/**
 * Convert a Zod schema to the draft-07 JSON Schema advertised to MCP clients.
 *
 * Kept byte-compatible with the zod-to-json-schema output clients saw before
 * the Zod 4 migration:
 * - The "output" view is used for tool inputs too, so plain objects advertise
 *   `additionalProperties: false` (Zod still strips unknown keys at runtime).
 * - Unions are advertised as `anyOf`; Zod 4 emits `oneOf` for discriminated
 *   unions, which some MCP clients handle less well.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchemaObject {
    return z.toJSONSchema(schema, {
        target: "draft-7",
        io: "output",
        override: ({ jsonSchema }) => {
            if (jsonSchema.oneOf) {
                jsonSchema.anyOf = jsonSchema.oneOf;
                delete jsonSchema.oneOf;
            }
        },
    }) as JsonSchemaObject;
}
