/**
 * Payload-aware `$batch` chunker tests (PRD `prd-bad-debt-excel-campaign.md`,
 * issue #69).
 *
 * Pure in/out: given items with attachment sizes, assert the chunk plan obeys
 * BOTH the ≤20 count cap AND the ~3 MB cumulative-payload budget. No Graph, no
 * storage — the seam is exercised in complete isolation.
 */
import { describe, it, expect } from "vitest";
import {
    chunkByPayload,
    base64Size,
    MAX_BATCH_SUBREQUESTS,
    MAX_BATCH_PAYLOAD_BYTES,
} from "../batchChunker";

const MB = 1024 * 1024;

describe("chunkByPayload — count cap", () => {
    it("caps each chunk at the sub-request count when items are tiny", () => {
        const items = Array.from({ length: 45 }, (_, i) => i);
        const chunks = chunkByPayload(items, () => 1);
        expect(chunks.map((c) => c.length)).toEqual([20, 20, 5]);
        // Every original item appears exactly once, order preserved.
        expect(chunks.flat()).toEqual(items);
    });

    it("respects a custom count cap", () => {
        const items = Array.from({ length: 7 }, (_, i) => i);
        const chunks = chunkByPayload(items, () => 0, { maxCount: 3 });
        expect(chunks.map((c) => c.length)).toEqual([3, 3, 1]);
    });
});

describe("chunkByPayload — byte budget", () => {
    it("starts a new chunk before the cumulative payload budget is breached", () => {
        // 1 MB each, 3 MB budget: three fit exactly (3 MB is not > 3 MB); the
        // fourth would make 4 MB, so it opens a new chunk — count cap never hit.
        const items = Array.from({ length: 5 }, (_, i) => i);
        const chunks = chunkByPayload(items, () => MB, { maxBytes: 3 * MB });
        expect(chunks.map((c) => c.length)).toEqual([3, 2]);
    });

    it("larger attachments mean fewer messages per chunk", () => {
        // 2 MB each vs a 3 MB budget → only one per chunk (2+2 = 4 MB > 3 MB).
        const items = Array.from({ length: 4 }, (_, i) => i);
        const chunks = chunkByPayload(items, () => 2 * MB, { maxBytes: 3 * MB });
        expect(chunks.map((c) => c.length)).toEqual([1, 1, 1, 1]);
    });

    it("places an item larger than the whole budget alone rather than dropping it", () => {
        // [small, HUGE, small]: HUGE (> budget) must still be sent, in its own chunk.
        const items = ["a", "HUGE", "b"];
        const sizeOf = (x: string) => (x === "HUGE" ? 10 * MB : 1);
        const chunks = chunkByPayload(items, sizeOf, { maxBytes: 3 * MB });
        expect(chunks).toEqual([["a"], ["HUGE"], ["b"]]);
        // Nothing dropped.
        expect(chunks.flat().sort()).toEqual(["HUGE", "a", "b"]);
    });
});

describe("chunkByPayload — both caps interact", () => {
    it("whichever cap trips first ends the chunk", () => {
        // 0.5 MB each with a 3 MB budget → 6 fit by bytes, but the count cap of 4
        // ends the chunk first.
        const items = Array.from({ length: 10 }, (_, i) => i);
        const chunks = chunkByPayload(items, () => 0.5 * MB, {
            maxCount: 4,
            maxBytes: 3 * MB,
        });
        // 3 MB budget allows 6 by bytes, but maxCount 4 wins → [4,4,2].
        expect(chunks.map((c) => c.length)).toEqual([4, 4, 2]);
    });

    it("defaults to Graph's 20-count and ~3 MB budget", () => {
        expect(MAX_BATCH_SUBREQUESTS).toBe(20);
        expect(MAX_BATCH_PAYLOAD_BYTES).toBe(3 * MB);
        // 20 tiny items fit one chunk by both defaults.
        const items = Array.from({ length: 20 }, (_, i) => i);
        expect(chunkByPayload(items, () => 10)).toHaveLength(1);
    });
});

describe("chunkByPayload — edges", () => {
    it("returns no chunks for an empty input", () => {
        expect(chunkByPayload([], () => 1)).toEqual([]);
    });

    it("treats negative sizes as zero", () => {
        const items = [1, 2, 3];
        expect(chunkByPayload(items, () => -100, { maxBytes: 1 })).toEqual([[1, 2, 3]]);
    });
});

describe("base64Size", () => {
    it("inflates raw bytes by ~4/3 with padding", () => {
        expect(base64Size(3)).toBe(4);
        expect(base64Size(1)).toBe(4); // 1 byte → 4 base64 chars (padded)
        expect(base64Size(6)).toBe(8);
        expect(base64Size(0)).toBe(0);
        expect(base64Size(-5)).toBe(0);
    });
});
