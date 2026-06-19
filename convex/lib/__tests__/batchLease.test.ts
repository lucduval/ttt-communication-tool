import { describe, test, expect } from "vitest";
import {
    LEASE_MS,
    HEARTBEAT_THROTTLE_MS,
    lastBeat,
    isDead,
    shouldBeat,
    type LeasedBatch,
} from "../batchLease";

const NOW = 1_000_000_000_000;

function batch(overrides: Partial<LeasedBatch> = {}): LeasedBatch {
    return { status: "processing", ...overrides };
}

describe("constants", () => {
    test("LEASE_MS is meaningfully larger than HEARTBEAT_THROTTLE_MS", () => {
        expect(LEASE_MS).toBeGreaterThan(HEARTBEAT_THROTTLE_MS);
        // Sizing target: a healthy worker beats ~6x within one lease window.
        expect(LEASE_MS).toBeGreaterThanOrEqual(HEARTBEAT_THROTTLE_MS * 5);
    });
});

describe("lastBeat", () => {
    test("prefers heartbeatAt when present", () => {
        expect(lastBeat(batch({ heartbeatAt: 500, startedAt: 100 }))).toBe(500);
    });

    test("falls back to startedAt when no heartbeat", () => {
        expect(lastBeat(batch({ startedAt: 100 }))).toBe(100);
    });

    test("falls back to 0 when neither present", () => {
        expect(lastBeat(batch())).toBe(0);
    });
});

describe("isDead", () => {
    test("alive and recently beaten → not dead", () => {
        expect(isDead(batch({ heartbeatAt: NOW - 1_000 }), NOW)).toBe(false);
    });

    test("processing with stale heartbeat → dead", () => {
        expect(isDead(batch({ heartbeatAt: NOW - LEASE_MS - 1 }), NOW)).toBe(true);
    });

    test("completed with stale heartbeat → not dead", () => {
        expect(
            isDead(batch({ status: "completed", heartbeatAt: NOW - LEASE_MS - 1 }), NOW),
        ).toBe(false);
    });

    test("failed with stale heartbeat → not dead", () => {
        expect(
            isDead(batch({ status: "failed", heartbeatAt: NOW - LEASE_MS - 1 }), NOW),
        ).toBe(false);
    });

    test("pre-heartbeat batch falls back to startedAt — fresh claim not dead", () => {
        expect(isDead(batch({ startedAt: NOW - 1_000 }), NOW)).toBe(false);
    });

    test("pre-heartbeat batch falls back to startedAt — stale claim dead", () => {
        expect(isDead(batch({ startedAt: NOW - LEASE_MS - 1 }), NOW)).toBe(true);
    });

    test("exactly at the lease boundary → not dead (strictly greater)", () => {
        expect(isDead(batch({ heartbeatAt: NOW - LEASE_MS }), NOW)).toBe(false);
    });
});

describe("shouldBeat", () => {
    test("just below the throttle → false", () => {
        expect(shouldBeat(NOW - (HEARTBEAT_THROTTLE_MS - 1), NOW)).toBe(false);
    });

    test("exactly at the throttle → true", () => {
        expect(shouldBeat(NOW - HEARTBEAT_THROTTLE_MS, NOW)).toBe(true);
    });

    test("above the throttle → true", () => {
        expect(shouldBeat(NOW - (HEARTBEAT_THROTTLE_MS + 1), NOW)).toBe(true);
    });
});
