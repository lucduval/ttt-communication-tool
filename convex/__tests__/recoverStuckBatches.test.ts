/**
 * Heartbeat-aware recovery sweep tests (PRD #39, issue #42).
 *
 * The sweep reaps `processing` batches whose lease has expired and re-kicks ONE
 * worker per affected campaign. These tests drive the plain `recoverStuckBatchesImpl`
 * against a faked Convex `ctx`, asserting the read-side of the Batch Lease:
 *   - a stale-heartbeat batch is reset to `pending` and exactly one worker is kicked;
 *   - a freshly-beating batch is left untouched;
 *   - at most one worker is scheduled per campaign even with several dead batches;
 *   - the "another batch still processing" skip is preserved;
 *   - a pre-heartbeat batch (no `heartbeatAt`) is reaped via the `startedAt` fallback.
 *
 * Times are expressed as offsets from `LEASE_MS` — never the raw millisecond
 * constant — so the tests pin relative lease ordering, not the tuning numbers.
 */
import { describe, it, expect, vi } from "vitest";
import { recoverStuckBatchesImpl } from "../campaignBatches";
import { LEASE_MS } from "../lib/batchLease";

type Batch = {
    _id: string;
    campaignId: string;
    status: string;
    startedAt?: number;
    heartbeatAt?: number;
};
type Campaign = { _id: string; status: string; channel: string };

function createCtx(batches: Batch[], campaigns: Campaign[]) {
    const scheduled: Array<{ ms: number; args: any }> = [];

    const queryFor = (constraints: Record<string, unknown>) =>
        batches.filter((b) =>
            Object.entries(constraints).every(([k, v]) => (b as any)[k] === v)
        );

    const ctx = {
        db: {
            query: (_table: string) => ({
                withIndex: (_index: string, fn: (q: any) => any) => {
                    const constraints: Record<string, unknown> = {};
                    const q = {
                        eq: (field: string, value: unknown) => {
                            constraints[field] = value;
                            return q;
                        },
                    };
                    fn(q);
                    return {
                        collect: async () => queryFor(constraints),
                        first: async () => queryFor(constraints)[0] ?? null,
                    };
                },
            }),
            patch: async (id: string, fields: Record<string, unknown>) => {
                const b = batches.find((x) => x._id === id);
                if (b) Object.assign(b, fields);
            },
            get: async (id: string) => campaigns.find((c) => c._id === id) ?? null,
        },
        scheduler: {
            runAfter: vi.fn(async (ms: number, _ref: unknown, args: any) => {
                scheduled.push({ ms, args });
            }),
        },
    };

    return { ctx, scheduled, batches };
}

// A fixed "now" comfortably past the lease window so offsets stay positive.
const NOW = 10 * LEASE_MS;
const now = () => NOW;
const stale = NOW - LEASE_MS - 1_000; // last beat older than the lease → dead
const fresh = NOW - 1_000; // last beat within the lease → alive

describe("recoverStuckBatchesImpl", () => {
    it("reaps a stale-heartbeat batch and kicks exactly one worker", async () => {
        const { ctx, scheduled, batches } = createCtx(
            [{ _id: "b1", campaignId: "c1", status: "processing", startedAt: stale, heartbeatAt: stale }],
            [{ _id: "c1", status: "processing", channel: "email" }]
        );

        const result = await recoverStuckBatchesImpl(ctx as any, now);

        expect(batches[0].status).toBe("pending");
        expect(batches[0].startedAt).toBeUndefined();
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0].args).toEqual({ campaignId: "c1" });
        expect(result).toEqual({ recovered: 1 });
    });

    it("leaves a freshly-beating batch untouched", async () => {
        const { ctx, scheduled, batches } = createCtx(
            [{ _id: "b1", campaignId: "c1", status: "processing", startedAt: stale, heartbeatAt: fresh }],
            [{ _id: "c1", status: "processing", channel: "email" }]
        );

        const result = await recoverStuckBatchesImpl(ctx as any, now);

        expect(batches[0].status).toBe("processing");
        expect(scheduled).toHaveLength(0);
        expect(result).toEqual({ recovered: 0 });
    });

    it("schedules at most one worker per campaign with several dead batches", async () => {
        const { ctx, scheduled } = createCtx(
            [
                { _id: "b1", campaignId: "c1", status: "processing", startedAt: stale, heartbeatAt: stale },
                { _id: "b2", campaignId: "c1", status: "processing", startedAt: stale, heartbeatAt: stale },
            ],
            [{ _id: "c1", status: "processing", channel: "email" }]
        );

        await recoverStuckBatchesImpl(ctx as any, now);

        expect(scheduled).toHaveLength(1);
        expect(scheduled[0].args).toEqual({ campaignId: "c1" });
    });

    it("preserves the skip when another batch is still processing", async () => {
        const { ctx, scheduled, batches } = createCtx(
            [
                { _id: "b1", campaignId: "c1", status: "processing", startedAt: stale, heartbeatAt: stale },
                { _id: "b2", campaignId: "c1", status: "processing", startedAt: stale, heartbeatAt: fresh },
            ],
            [{ _id: "c1", status: "processing", channel: "email" }]
        );

        await recoverStuckBatchesImpl(ctx as any, now);

        // b1 reaped, b2 still alive/processing → skip scheduling.
        expect(batches.find((b) => b._id === "b1")!.status).toBe("pending");
        expect(batches.find((b) => b._id === "b2")!.status).toBe("processing");
        expect(scheduled).toHaveLength(0);
    });

    it("reaps a pre-heartbeat batch via the startedAt fallback", async () => {
        const { ctx, scheduled, batches } = createCtx(
            [{ _id: "b1", campaignId: "c1", status: "processing", startedAt: stale }],
            [{ _id: "c1", status: "processing", channel: "email" }]
        );

        await recoverStuckBatchesImpl(ctx as any, now);

        expect(batches[0].status).toBe("pending");
        expect(scheduled).toHaveLength(1);
    });
});
