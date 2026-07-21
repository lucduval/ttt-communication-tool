/**
 * Payload-aware Microsoft Graph `$batch` chunker — pure core (PRD
 * `prd-bad-debt-excel-campaign.md`, issue #69).
 *
 * Graph caps a `$batch` at **20 sub-requests**. Once each email carries its own
 * invoice PDF (base64-inlined), 20 large attachments can push a single `$batch`
 * POST past the request-size ceiling, so the count cap alone is no longer enough.
 * This chunker enforces **both**: at most `maxCount` sub-requests **and** a
 * cumulative payload byte budget (`maxBytes`, ~3 MB) per chunk. Larger PDFs
 * simply mean fewer messages per chunk; per-message stays well under Graph's
 * ~4 MB per-request limit.
 *
 * Pure and generic (the item type is opaque; the caller supplies `sizeOf`) so it
 * is unit-tested in isolation — no Graph, no storage, no `ctx`.
 */

/** Graph's hard cap on `$batch` sub-requests per call. */
export const MAX_BATCH_SUBREQUESTS = 20;

/**
 * Cumulative base64-payload budget per `$batch`, ~3 MB. Deliberately below
 * Graph's ~4 MB request ceiling to leave headroom for the JSON envelope and
 * per-message metadata (subject, headers, recipient objects).
 */
export const MAX_BATCH_PAYLOAD_BYTES = 3 * 1024 * 1024;

/** Base64 encodes 3 raw bytes as 4 chars (padded), so inflates size by ~4/3. */
export function base64Size(rawBytes: number): number {
    if (rawBytes <= 0) return 0;
    return Math.ceil(rawBytes / 3) * 4;
}

export interface ChunkLimits {
    /** Max sub-requests per chunk. Defaults to {@link MAX_BATCH_SUBREQUESTS}. */
    maxCount?: number;
    /** Max cumulative payload bytes per chunk. Defaults to {@link MAX_BATCH_PAYLOAD_BYTES}. */
    maxBytes?: number;
}

/**
 * Greedily pack `items` into chunks obeying **both** the count cap and the byte
 * budget. A new chunk is started as soon as adding the next item would breach
 * either limit.
 *
 * An item whose own size exceeds `maxBytes` is never dropped — it lands alone in
 * its own chunk (per-message still sits under Graph's ~4 MB per-request limit, so
 * a single oversized PDF is fine on its own). Order is preserved.
 */
export function chunkByPayload<T>(
    items: readonly T[],
    sizeOf: (item: T) => number,
    limits: ChunkLimits = {},
): T[][] {
    const maxCount = limits.maxCount ?? MAX_BATCH_SUBREQUESTS;
    const maxBytes = limits.maxBytes ?? MAX_BATCH_PAYLOAD_BYTES;

    const chunks: T[][] = [];
    let current: T[] = [];
    let currentBytes = 0;

    for (const item of items) {
        const size = Math.max(0, sizeOf(item));
        const wouldExceedCount = current.length >= maxCount;
        // The `current.length > 0` guard is what lets an item larger than the
        // whole budget still be placed (alone) rather than looping forever.
        const wouldExceedBytes = current.length > 0 && currentBytes + size > maxBytes;

        if (wouldExceedCount || wouldExceedBytes) {
            chunks.push(current);
            current = [];
            currentBytes = 0;
        }

        current.push(item);
        currentBytes += size;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}
