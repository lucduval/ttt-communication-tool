/**
 * Write-rate backoff helper (convex/lib/writeRetry.ts).
 *
 * Convex enforces a deployment-wide ~4 MiB/s write ceiling and surfaces a breach
 * as a `TooManyWrites` error. `withWriteRetry` retries the SAME write on that
 * breach with growing backoff, and passes every other error straight through.
 */
import { describe, it, expect } from "vitest";
import {
    isTooManyWrites,
    withWriteRetry,
    WRITE_RETRY_BACKOFF_BASE_MS,
} from "../writeRetry";

class TooManyWritesError extends Error {
    constructor() {
        super(
            "TooManyWrites: Too many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second."
        );
        this.name = "TooManyWritesError";
    }
}

describe("isTooManyWrites", () => {
    it("matches the Convex write-rate breach message and nothing else", () => {
        expect(isTooManyWrites(new TooManyWritesError())).toBe(true);
        expect(isTooManyWrites(new Error("Too Many Writes per second"))).toBe(true);
        expect(isTooManyWrites(new Error("some other failure"))).toBe(false);
        expect(isTooManyWrites("not even an error")).toBe(false);
    });
});

describe("withWriteRetry", () => {
    it("returns immediately when the write succeeds first try", async () => {
        const slept: number[] = [];
        const result = await withWriteRetry(async () => 42, async (ms) => {
            slept.push(ms);
        });
        expect(result).toBe(42);
        expect(slept).toEqual([]);
    });

    it("backs off and retries the same write until it lands", async () => {
        const slept: number[] = [];
        let calls = 0;
        const result = await withWriteRetry(
            async () => {
                calls++;
                if (calls < 3) throw new TooManyWritesError();
                return "ok";
            },
            async (ms) => {
                slept.push(ms);
            }
        );
        expect(result).toBe("ok");
        expect(calls).toBe(3);
        // Exponential backoff: base, base*2 before the third (successful) attempt.
        expect(slept).toEqual([WRITE_RETRY_BACKOFF_BASE_MS, WRITE_RETRY_BACKOFF_BASE_MS * 2]);
    });

    it("throws after the retry budget is exhausted", async () => {
        const slept: number[] = [];
        let calls = 0;
        await expect(
            withWriteRetry(
                async () => {
                    calls++;
                    throw new TooManyWritesError();
                },
                async (ms) => {
                    slept.push(ms);
                },
                2 // maxRetries
            )
        ).rejects.toThrow(/too many writes/i);
        // 1 initial attempt + 2 retries = 3 calls, sleeping before each retry.
        expect(calls).toBe(3);
        expect(slept).toHaveLength(2);
    });

    it("propagates a non-rate-limit error without retrying", async () => {
        const slept: number[] = [];
        let calls = 0;
        await expect(
            withWriteRetry(
                async () => {
                    calls++;
                    throw new Error("write conflict, not a rate limit");
                },
                async (ms) => {
                    slept.push(ms);
                }
            )
        ).rejects.toThrow("write conflict");
        expect(calls).toBe(1);
        expect(slept).toEqual([]);
    });
});
