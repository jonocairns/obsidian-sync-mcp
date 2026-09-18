import { posix } from "node:path";
import { UserError, jsonSchemaAdapter, type JsonSchemaObject, type ViteMCP } from "@vitemcp/server";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { validAttachmentPath, validSourceNotePath, attachmentLimitForPath } from "./attachment-path.js";
import { validateAttachment, type AttachmentMime } from "./attachment-validation.js";
import type { VaultBackend, VersionedAttachment } from "./vault-backend.js";

export interface AttachmentLimits {
    imageMaxBytes: number;
    pdfMaxBytes: number;
    maxPixels: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
    imageMaxBytes: 10 * 1024 * 1024,
    pdfMaxBytes: 20 * 1024 * 1024,
    maxPixels: 40_000_000,
};

export type AttachmentErrorCode =
    | "INVALID_INPUT" | "INVALID_PATH" | "SOURCE_NOTE_NOT_FOUND" | "NOT_FOUND" | "AMBIGUOUS"
    | "TOO_LARGE" | "UNSUPPORTED_CONTENT" | "MALFORMED_CONTENT" | "DIMENSION_LIMIT" | "BACKEND_UNAVAILABLE";

export type AttachmentResult =
    | { schemaVersion: "1.0.0"; status: "ok"; result: {
        path: string; mimeType: AttachmentMime; size: number; version: string; modified: string;
        uri: string; width?: number; height?: number;
    } }
    | { schemaVersion: "1.0.0"; status: "error"; error: {
        code: AttachmentErrorCode; message: string; size?: number; maxBytes?: number;
        candidates?: string[];
    } };

export const attachmentResultSchema = z.discriminatedUnion("status", [
    z.object({
        schemaVersion: z.literal("1.0.0"), status: z.literal("ok"),
        result: z.object({
            path: z.string(), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "application/pdf"]),
            size: z.number().int().nonnegative(), version: z.string(), modified: z.string(), uri: z.string(),
            width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
        }).strict(),
    }).strict(),
    z.object({
        schemaVersion: z.literal("1.0.0"), status: z.literal("error"),
        error: z.object({
            code: z.enum(["INVALID_INPUT", "INVALID_PATH", "SOURCE_NOTE_NOT_FOUND", "NOT_FOUND", "AMBIGUOUS", "TOO_LARGE", "UNSUPPORTED_CONTENT", "MALFORMED_CONTENT", "DIMENSION_LIMIT", "BACKEND_UNAVAILABLE"]),
            message: z.string(), size: z.number().int().nonnegative().optional(), maxBytes: z.number().int().positive().optional(),
            candidates: z.array(z.string()).optional(),
        }).strict(),
    }).strict(),
]);
const attachmentOutputSchema = jsonSchemaAdapter({
    ...zodToJsonSchema(attachmentResultSchema, { $refStrategy: "none" }) as JsonSchemaObject,
    type: "object",
});

const messages: Record<AttachmentErrorCode, string> = {
    INVALID_INPUT: "Provide an exact path, or an embed target and source note path.",
    INVALID_PATH: "The attachment path or embed target is invalid.",
    SOURCE_NOTE_NOT_FOUND: "The source note does not exist.",
    NOT_FOUND: "The attachment does not exist.",
    AMBIGUOUS: "The embed target matches multiple attachments; use an exact path.",
    TOO_LARGE: "The attachment exceeds the configured byte limit.",
    UNSUPPORTED_CONTENT: "The attachment is not a supported PNG, JPEG, WebP, or PDF.",
    MALFORMED_CONTENT: "The attachment content is malformed.",
    DIMENSION_LIMIT: "The image dimensions exceed the configured limit.",
    BACKEND_UNAVAILABLE: "The vault backend could not read the attachment.",
};

function error(code: AttachmentErrorCode, extras: Partial<Extract<AttachmentResult, { status: "error" }>["error"]> = {}): AttachmentResult {
    return { schemaVersion: "1.0.0", status: "error", error: { code, message: messages[code], ...extras } };
}

export function parseAttachmentLimits(env: NodeJS.ProcessEnv): AttachmentLimits {
    function value(name: string, fallback: number): number {
        const raw = env[name];
        if (raw === undefined || raw === "") return fallback;
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100 * 1024 * 1024) {
            throw new Error(`${name} must be a positive integer no greater than 104857600.`);
        }
        return parsed;
    }
    return {
        imageMaxBytes: value("ATTACHMENT_MAX_IMAGE_BYTES", DEFAULT_ATTACHMENT_LIMITS.imageMaxBytes),
        pdfMaxBytes: value("ATTACHMENT_MAX_PDF_BYTES", DEFAULT_ATTACHMENT_LIMITS.pdfMaxBytes),
        maxPixels: value("ATTACHMENT_MAX_PIXELS", DEFAULT_ATTACHMENT_LIMITS.maxPixels),
    };
}

export function attachmentUri(path: string, version: string): string {
    return `obsidian-attachment://vault/${Buffer.from(path).toString("base64url")}/${version}`;
}

function pathFromUriId(id: string): string | null {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const path = Buffer.from(id, "base64url").toString("utf8");
    return Buffer.from(path).toString("base64url") === id && validAttachmentPath(path) ? path : null;
}

function normalizeTarget(target: string): string {
    const trimmed = target.trim();
    const wiki = /^!\[\[([^\]]+)\]\]$/.exec(trimmed);
    const markdown = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(trimmed);
    let value = wiki?.[1]?.split("|")[0] ?? markdown?.[1] ?? trimmed;
    if (markdown) {
        try { value = decodeURIComponent(value); } catch { return ""; }
    }
    return value.split("#")[0].trim();
}

export async function resolveAttachmentPath(
    vault: VaultBackend,
    input: { path?: string; target?: string; sourceNotePath?: string },
): Promise<{ status: "ok"; path: string } | Extract<AttachmentResult, { status: "error" }>> {
    if (input.path !== undefined) {
        if (input.target !== undefined || input.sourceNotePath !== undefined) return error("INVALID_INPUT") as Extract<AttachmentResult, { status: "error" }>;
        if (!validAttachmentPath(input.path)) return error("INVALID_PATH") as Extract<AttachmentResult, { status: "error" }>;
        return { status: "ok", path: input.path };
    }
    if (input.target === undefined || input.sourceNotePath === undefined) return error("INVALID_INPUT") as Extract<AttachmentResult, { status: "error" }>;
    if (!validSourceNotePath(input.sourceNotePath)) return error("INVALID_PATH") as Extract<AttachmentResult, { status: "error" }>;
    const target = normalizeTarget(input.target);
    if (!target || target.includes("\\") || target.includes("\0")) return error("INVALID_PATH") as Extract<AttachmentResult, { status: "error" }>;
    const sourceFolder = posix.dirname(input.sourceNotePath);
    const absolute = target.startsWith("/");
    const relative = target.startsWith("./") || target.startsWith("../");
    const requested = absolute ? target.slice(1) : target;
    const candidatePaths = relative
        ? [posix.normalize(posix.join(sourceFolder, requested))]
        : absolute ? [requested]
            : target.includes("/") ? [target, posix.normalize(posix.join(sourceFolder, target))] : [];
    if (candidatePaths.some((path) => !validAttachmentPath(path)) ||
        (candidatePaths.length === 0 && !validAttachmentPath(target))) {
        return error("INVALID_PATH") as Extract<AttachmentResult, { status: "error" }>;
    }
    const source = await vault.readVersioned(input.sourceNotePath);
    if (source.status !== "ok") {
        const code = source.code === "NOTE_NOT_FOUND" || source.code === "RESTORE_REQUIRED"
            ? "SOURCE_NOTE_NOT_FOUND" : source.code === "INVALID_PATH" ? "INVALID_PATH" : "BACKEND_UNAVAILABLE";
        return error(code) as Extract<AttachmentResult, { status: "error" }>;
    }
    let paths: string[];
    try { paths = await vault.listAttachments(); }
    catch { return error("BACKEND_UNAVAILABLE") as Extract<AttachmentResult, { status: "error" }>; }
    const candidates = new Set<string>();
    if (candidatePaths.length > 0) {
        const wanted = new Set(candidatePaths.map((path) => path.toLowerCase()));
        for (const path of paths) if (wanted.has(path.toLowerCase())) candidates.add(path);
    } else {
        const lowerTarget = target.toLowerCase();
        for (const path of paths) if (posix.basename(path).toLowerCase() === lowerTarget) candidates.add(path);
    }
    if (candidates.size === 0) return error("NOT_FOUND") as Extract<AttachmentResult, { status: "error" }>;
    if (candidates.size > 1) return error("AMBIGUOUS", { candidates: [...candidates].sort().slice(0, 100) }) as Extract<AttachmentResult, { status: "error" }>;
    return { status: "ok", path: [...candidates][0] };
}

type ValidatedAttachment = { attachment: VersionedAttachment; mimeType: AttachmentMime; width?: number; height?: number };
export async function readValidatedAttachment(
    vault: VaultBackend, path: string, limits: AttachmentLimits,
): Promise<{ status: "ok"; value: ValidatedAttachment } | Extract<AttachmentResult, { status: "error" }>> {
    if (!validAttachmentPath(path)) return error("INVALID_PATH") as Extract<AttachmentResult, { status: "error" }>;
    const maxBytes = attachmentLimitForPath(path, limits.imageMaxBytes, limits.pdfMaxBytes);
    const read = await vault.readAttachment(path, maxBytes);
    if (read.status === "error") {
        if (read.code === "TOO_LARGE") return error("TOO_LARGE", { size: read.size, maxBytes }) as Extract<AttachmentResult, { status: "error" }>;
        return error(read.code === "NOTE_NOT_FOUND" ? "NOT_FOUND" : read.code) as Extract<AttachmentResult, { status: "error" }>;
    }
    const validated = validateAttachment(read.attachment.bytes, limits.maxPixels);
    if (validated.status === "error") return error(validated.code) as Extract<AttachmentResult, { status: "error" }>;
    const actualLimit = validated.mimeType === "application/pdf" ? limits.pdfMaxBytes : limits.imageMaxBytes;
    if (read.attachment.size > actualLimit) return error("TOO_LARGE", { size: read.attachment.size, maxBytes: actualLimit }) as Extract<AttachmentResult, { status: "error" }>;
    return { status: "ok", value: { attachment: read.attachment, mimeType: validated.mimeType, width: validated.width, height: validated.height } };
}

export function registerAttachmentTools(server: ViteMCP, vault: VaultBackend, limits: AttachmentLimits): void {
    server.addResourceTemplate({
        uriTemplate: "obsidian-attachment://vault/{id}/{version}",
        name: "Vault attachment",
        description: "Read a versioned PNG, JPEG, WebP, or PDF already in the vault.",
        arguments: [{ name: "id", required: true }, { name: "version", required: true }],
        async load({ id, version }) {
            const path = pathFromUriId(id);
            if (!path) throw new UserError("Invalid attachment resource URI.");
            const read = await readValidatedAttachment(vault, path, limits);
            if (read.status === "error") throw new UserError(read.error.message);
            if (read.value.attachment.version !== version) throw new UserError("Attachment version changed; read it again through read_attachment.");
            return { blob: Buffer.from(read.value.attachment.bytes).toString("base64"), mimeType: read.value.mimeType };
        },
    });

    server.addTool({
        name: "read_attachment",
        description: "Read an existing vault image or PDF by exact path, or by embed target plus source note path. Images are returned as image content; PDFs as binary resources.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        parameters: z.object({
            path: z.string().optional().describe("Exact vault-relative attachment path."),
            target: z.string().optional().describe("Obsidian embed target, such as image.png or ![[image.png]]."),
            sourceNotePath: z.string().optional().describe("Vault-relative Markdown note path containing the embed."),
        }),
        outputSchema: attachmentOutputSchema,
        async execute(input) {
            const resolved = await resolveAttachmentPath(vault, input);
            if (resolved.status === "error") return { content: [{ type: "text" as const, text: JSON.stringify(resolved) }], structuredContent: resolved, isError: true };
            const read = await readValidatedAttachment(vault, resolved.path, limits);
            if (read.status === "error") return { content: [{ type: "text" as const, text: JSON.stringify(read) }], structuredContent: read, isError: true };
            const { attachment, mimeType, width, height } = read.value;
            const uri = attachmentUri(attachment.path, attachment.version);
            const result: AttachmentResult = { schemaVersion: "1.0.0", status: "ok", result: {
                path: attachment.path, mimeType, size: attachment.size, version: attachment.version,
                modified: new Date(attachment.mtime).toISOString(), uri, width, height,
            } };
            const blob = Buffer.from(attachment.bytes).toString("base64");
            const binary = mimeType === "application/pdf"
                ? { type: "resource" as const, resource: { uri, mimeType, blob } }
                : { type: "image" as const, mimeType, data: blob };
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }, binary], structuredContent: result };
        },
    });
}
