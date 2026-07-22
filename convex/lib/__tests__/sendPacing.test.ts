/**
 * Byte-aware send pacing core (convex/lib/sendPacing.ts).
 *
 * Pins the rate arithmetic that keeps the email sender under Microsoft Graph's
 * IncomingBytes throttle: the pause after a chunk scales with the chunk's bytes,
 * so small emails pace ~instantly and big ones pace proportionally longer.
 */
import { describe, it, expect } from "vitest";
import {
    computeSendPaceMs,
    DEFAULT_TARGET_BYTES_PER_SEC,
    DEFAULT_MAX_PACE_MS,
} from "../sendPacing";

describe("computeSendPaceMs", () => {
    it("scales the pause with the chunk's byte size", () => {
        // At the default 300 KB/s, a 300 KB chunk should pace ~1s and a 30 KB
        // chunk ~0.1s — an order of magnitude apart, tracking payload size.
        const big = computeSendPaceMs(300_000);
        const small = computeSendPaceMs(30_000);
        expect(big).toBe(1000);
        expect(small).toBe(100);
        expect(big).toBeGreaterThan(small);
    });

    it("is bytes-per-second exact at the target rate", () => {
        expect(computeSendPaceMs(DEFAULT_TARGET_BYTES_PER_SEC, DEFAULT_TARGET_BYTES_PER_SEC)).toBe(
            1000
        );
        expect(computeSendPaceMs(600_000, 300_000)).toBe(2000);
    });

    it("returns 0 for an empty or non-positive chunk", () => {
        expect(computeSendPaceMs(0)).toBe(0);
        expect(computeSendPaceMs(-5)).toBe(0);
    });

    it("caps a single pause at maxPaceMs so one huge chunk can't stall the action", () => {
        // 100 MB at 300 KB/s would be ~333s; capped to the default 60s.
        expect(computeSendPaceMs(100 * 1024 * 1024)).toBe(DEFAULT_MAX_PACE_MS);
        expect(computeSendPaceMs(10_000_000, 300_000, 5_000)).toBe(5_000);
    });

    it("faster target throughput means shorter pauses", () => {
        const slow = computeSendPaceMs(300_000, 100_000);
        const fast = computeSendPaceMs(300_000, 600_000);
        expect(slow).toBe(3000);
        expect(fast).toBe(500);
    });

    it("falls back to the default target if the configured rate is non-positive", () => {
        // A mis-set env (0 or negative) must never divide-by-zero or send unpaced.
        expect(computeSendPaceMs(300_000, 0)).toBe(computeSendPaceMs(300_000));
        expect(computeSendPaceMs(300_000, -100)).toBe(1000);
    });
});
