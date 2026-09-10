// @types/pouchdb-core 7.0.15 merges a pre-generic global Buffer into Node's
// declaration. Preserve Node's generic backing buffer and slice signature so
// Buffers remain assignable to Uint8Array under TypeScript 5.9. This changes
// declarations only; it neither patches dependencies nor erases Commonlib types.
interface Buffer<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
    readonly buffer: TArrayBuffer;
    slice(start?: number, end?: number): Buffer<ArrayBuffer>;
}
