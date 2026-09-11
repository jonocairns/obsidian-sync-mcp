/** Decode a Commonlib loaded entry identically for direct reads and indexing. */
import { decodeBinary } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/convert";

export interface EncodedNoteContent {
    data?: unknown;
    type?: string;
    datatype?: string;
}

export function decodeNoteBytes(doc: EncodedNoteContent): Uint8Array {
    const data = doc.data ?? "";
    if (typeof data !== "string" && !(Array.isArray(data) && data.every((part) => typeof part === "string"))) {
        throw new Error("Invalid note content representation");
    }
    return doc.type === "newnote" || doc.type === "notes" || doc.datatype === "newnote"
        ? new Uint8Array(decodeBinary(data))
        : new TextEncoder().encode(Array.isArray(data) ? data.join("") : data);
}
