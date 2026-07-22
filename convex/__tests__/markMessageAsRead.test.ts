/**
 * Bounce NDR mark-as-read throttling (convex/bounces.ts).
 *
 * Marking bounce NDRs as read is a per-message Graph PATCH. Production flooded
 * with "Failed to mark message … as read: 429" because the marks fired back to
 * back with no backoff. `markMessageAsRead` now retries on 429/5xx with
 * exponential backoff that honours the server's `Retry-After`, and never throws
 * so a stubborn message can't abort the whole processBounces action.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { markMessageAsRead } from "../bounces";

function graphResponse(status: number, headers: Record<string, string> = {}): Response {
    return new Response(status === 200 ? null : "err", {
        status,
        headers,
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("markMessageAsRead", () => {
    it("succeeds on the first try without backing off", async () => {
        const fetchMock = vi.fn(async () => graphResponse(200));
        vi.stubGlobal("fetch", fetchMock);
        const slept: number[] = [];

        const ok = await markMessageAsRead("tok", "mbx@ttt.test", "m1", async (ms) => {
            slept.push(ms);
        });

        expect(ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
    });

    it("retries a 429 honouring Retry-After, then succeeds", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(graphResponse(429, { "Retry-After": "2" }))
            .mockResolvedValueOnce(graphResponse(200));
        vi.stubGlobal("fetch", fetchMock);
        const slept: number[] = [];

        const ok = await markMessageAsRead("tok", "mbx@ttt.test", "m1", async (ms) => {
            slept.push(ms);
        });

        expect(ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // Honoured the server's Retry-After (2s) rather than the exponential fallback.
        expect(slept).toEqual([2000]);
    });

    it("caps an absurd Retry-After so one message can't stall the action", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(graphResponse(429, { "Retry-After": "99999" }))
            .mockResolvedValueOnce(graphResponse(200));
        vi.stubGlobal("fetch", fetchMock);
        const slept: number[] = [];

        await markMessageAsRead("tok", "mbx@ttt.test", "m1", async (ms) => {
            slept.push(ms);
        });

        expect(slept).toEqual([30_000]); // capped at MARK_READ_MAX_RETRY_AFTER_MS
    });

    it("retries a 5xx with exponential fallback when no Retry-After is given", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(graphResponse(503))
            .mockResolvedValueOnce(graphResponse(200));
        vi.stubGlobal("fetch", fetchMock);
        const slept: number[] = [];

        const ok = await markMessageAsRead("tok", "mbx@ttt.test", "m1", async (ms) => {
            slept.push(ms);
        });

        expect(ok).toBe(true);
        expect(slept).toEqual([500]); // MARK_READ_BACKOFF_BASE_MS * 2**0
    });

    it("gives up gracefully (returns false, never throws) after exhausting retries", async () => {
        const fetchMock = vi.fn(async () => graphResponse(429, { "Retry-After": "0" }));
        vi.stubGlobal("fetch", fetchMock);

        const ok = await markMessageAsRead("tok", "mbx@ttt.test", "m1", async () => {});

        expect(ok).toBe(false);
        // MARK_READ_MAX_ATTEMPTS = 5 total attempts.
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("does not retry a non-retryable 4xx", async () => {
        const fetchMock = vi.fn(async () => graphResponse(404));
        vi.stubGlobal("fetch", fetchMock);
        const slept: number[] = [];

        const ok = await markMessageAsRead("tok", "mbx@ttt.test", "m1", async (ms) => {
            slept.push(ms);
        });

        expect(ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
    });
});
