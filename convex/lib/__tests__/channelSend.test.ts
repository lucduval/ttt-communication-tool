/**
 * Channel Send driver tests (PRD #8, issue #13).
 *
 * The driver owns the batch lifecycle independent of channel. These tests drive
 * `runChannelSend` against a *fake* Channel Sender and a faked Convex `ctx`,
 * asserting the lifecycle the driver — not any adapter — is responsible for:
 * claim → flush-every-25 → mark-complete → reschedule-with-`nextDelayMs`, the
 * `halt`-stops-scheduling path, the paused-campaign short-circuit, the unified
 * lost-claim-race rule, and mark-failed-and-continue on a thrown error.
 */
import { describe, it, expect, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { runChannelSend, FLUSH_INTERVAL, type ChannelSender, type EmitFn } from "../channelSend";
import { HEARTBEAT_THROTTLE_MS } from "../batchLease";

type Update = {
    recipientId: string;
    status: "sent" | "failed";
    sentAt?: number;
    errorMessage?: string;
    externalMessageId?: string;
};

interface CtxOpts {
    campaign?: unknown;
    batch?: unknown;
    acquired?: boolean;
    hasMoreBatches?: boolean;
    /** Existing `messages` rows the eligibility query returns for the batch. */
    existingRows?: Array<{ recipientId: string; status: string }>;
}

function createCtx(opts: CtxOpts) {
    const updateBatches: Update[][] = [];
    const scheduled: Array<{ ms: number; name: string }> = [];
    const mutations: Array<{ name: string; args: any }> = [];

    const ctx = {
        runQuery: vi.fn(async (ref: unknown, _args?: any) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getCampaign":
                    return opts.campaign;
                case "campaignBatches:getNextPendingBatchInternal":
                    return opts.batch;
                case "messages:getExistingMessageStatuses":
                    return opts.existingRows ?? [];
                default:
                    return undefined;
            }
        }),
        runMutation: vi.fn(async (ref: unknown, args: any) => {
            const name = getFunctionName(ref as any);
            mutations.push({ name, args });
            if (name === "messages:updateStatusBatch") updateBatches.push(args.updates);
            if (name === "campaignBatches:markBatchProcessing")
                return { acquired: opts.acquired ?? true };
            if (name === "campaignBatches:markBatchComplete")
                return { hasMoreBatches: opts.hasMoreBatches ?? false };
            if (name === "campaignBatches:markBatchFailed")
                return { hasMoreBatches: opts.hasMoreBatches ?? false };
            return undefined;
        }),
        runAction: vi.fn(async () => undefined),
        scheduler: {
            runAfter: vi.fn(async (ms: number, ref: unknown) => {
                scheduled.push({ ms, name: getFunctionName(ref as any) });
            }),
        },
    };

    return { ctx, updateBatches, scheduled, mutations };
}

/** A fake email Channel Sender whose send loop is supplied per test. */
function fakeSender(
    sendBatch: ChannelSender["sendBatch"],
    overrides: Partial<ChannelSender> = {}
): ChannelSender {
    return { channel: "email", errorRetryDelayMs: 10000, sendBatch, ...overrides };
}

const campaign = { _id: "c1", status: "active" };
const batch = { _id: "batch-1", recipients: [] };

describe("runChannelSend driver", () => {
    it("claims, flushes every 25, marks complete, and reschedules with nextDelayMs", async () => {
        // Sender emits 60 results one at a time → the driver flushes at 25, 50, and
        // a final flush of the remaining 10.
        const sender = fakeSender(async (_ctx, _campaign, _batch, emit: EmitFn) => {
            for (let i = 0; i < 60; i++) {
                await emit([{ recipientId: `r${i}`, success: i % 2 === 0 }]);
            }
            return { nextDelayMs: 500 };
        });

        const { ctx, updateBatches, scheduled, mutations } = createCtx({
            campaign,
            batch,
            hasMoreBatches: true,
        });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        // Three flushes: 25 + 25 + 10.
        expect(updateBatches.map((u) => u.length)).toEqual([FLUSH_INTERVAL, FLUSH_INTERVAL, 10]);

        // markBatchComplete gets the driver-computed success/failed counts (30/30).
        const complete = mutations.find((m) => m.name === "campaignBatches:markBatchComplete");
        expect(complete?.args).toMatchObject({ successCount: 30, failedCount: 30 });

        // Successor scheduled for the same channel after the adapter's nextDelayMs.
        expect(scheduled).toEqual([{ ms: 500, name: "campaignQueue:processEmailBatch" }]);
    });

    it("runs the eligibility query once at batch start and passes only eligible recipients to the adapter", async () => {
        // The driver owns the send-path idempotency seam (PRD #55 / #56): it
        // queries existing rows once, applies the pure eligibility rule, and hands
        // the adapter only recipients with no row in any status. r2 has a terminal
        // `failed` row, so it is already-handled and must not reach the adapter.
        const batchWithRecipients = {
            _id: "batch-1",
            recipients: [
                { id: "r1", name: "Alice" },
                { id: "r2", name: "Bob" },
                { id: "r3", name: "Carol" },
            ],
        };

        let received: Array<{ id: string }> | undefined;
        const sender = fakeSender(async (_ctx, _campaign, _batch, _emit, eligible) => {
            received = eligible;
            return {};
        });

        const { ctx } = createCtx({
            campaign,
            batch: batchWithRecipients,
            existingRows: [{ recipientId: "r2", status: "failed" }],
        });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        expect(received?.map((r) => r.id)).toEqual(["r1", "r3"]);

        // The eligibility query is scoped to exactly this batch's recipients and
        // runs once.
        const eligibilityCalls = ctx.runQuery.mock.calls.filter(
            (c) => getFunctionName(c[0] as any) === "messages:getExistingMessageStatuses"
        );
        expect(eligibilityCalls).toHaveLength(1);
        expect(eligibilityCalls[0][1]).toEqual({
            campaignId: "c1",
            recipientIds: ["r1", "r2", "r3"],
        });
    });

    it("sends to ALL recipients of a fresh campaign whose rows are the createBatches-seeded `pending` (not zero) (#63)", async () => {
        // Integration guard for the #63 collision: createBatches pre-creates a
        // `pending` row for every recipient before the driver runs. If `pending`
        // blocked, the eligibility query would filter EVERYONE out and the batch
        // would send zero. The driver must hand the adapter all three recipients.
        const batchWithRecipients = {
            _id: "batch-1",
            recipients: [
                { id: "r1", name: "Alice" },
                { id: "r2", name: "Bob" },
                { id: "r3", name: "Carol" },
            ],
        };

        let received: Array<{ id: string }> | undefined;
        const sender = fakeSender(async (_ctx, _campaign, _batch, _emit, eligible) => {
            received = eligible;
            return {};
        });

        const { ctx } = createCtx({
            campaign,
            batch: batchWithRecipients,
            existingRows: [
                { recipientId: "r1", status: "pending" },
                { recipientId: "r2", status: "pending" },
                { recipientId: "r3", status: "pending" },
            ],
        });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        expect(received?.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    });

    it("hands the adapter a markAttempted that enriches ids into the driver-owned idempotent upsert", async () => {
        // The driver owns the `attempted` write shape (PRD #55 / #58): the adapter
        // calls markAttempted with bare ids; the driver enriches them from
        // batch.recipients (email/phone/name) + its channel and delegates to the
        // single idempotent `messages.markAttemptedBatch` upsert.
        const batchWithRecipients = {
            _id: "batch-1",
            recipients: [
                { id: "r1", email: "a@x.test", name: "Alice" },
                { id: "r2", phone: "+2782", name: "Bob" },
                { id: "r3", email: "c@x.test", name: "Carol" },
            ],
        };

        const sender = fakeSender(
            async (_ctx, _campaign, _batch, _emit, _eligible, markAttempted) => {
                // The adapter marks a chunk of two of the three recipients.
                await markAttempted(["r1", "r3"]);
                return {};
            }
        );

        const { ctx, mutations } = createCtx({ campaign, batch: batchWithRecipients });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        const mark = mutations.find((m) => m.name === "messages:markAttemptedBatch");
        expect(mark?.args).toEqual({
            campaignId: "c1",
            channel: "email",
            recipients: [
                { recipientId: "r1", recipientEmail: "a@x.test", recipientPhone: undefined, recipientName: "Alice" },
                { recipientId: "r3", recipientEmail: "c@x.test", recipientPhone: undefined, recipientName: "Carol" },
            ],
        });
    });

    it("does not issue an upsert when the adapter marks an empty chunk", async () => {
        const sender = fakeSender(
            async (_ctx, _campaign, _batch, _emit, _eligible, markAttempted) => {
                await markAttempted([]);
                return {};
            }
        );

        const { ctx, mutations } = createCtx({ campaign, batch });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        expect(mutations.some((m) => m.name === "messages:markAttemptedBatch")).toBe(false);
    });

    it("maps emitted results to per-recipient status writes (incl. externalMessageId)", async () => {
        const sender = fakeSender(async (_ctx, _campaign, _batch, emit: EmitFn) => {
            await emit([{ recipientId: "a", success: true, externalMessageId: "wamid-1" }]);
            await emit([{ recipientId: "b", success: false, error: "nope" }]);
            return {};
        });

        const { ctx, updateBatches } = createCtx({ campaign, batch });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        const flat = updateBatches.flat();
        expect(flat).toEqual([
            expect.objectContaining({
                recipientId: "a",
                status: "sent",
                externalMessageId: "wamid-1",
            }),
            expect.objectContaining({
                recipientId: "b",
                status: "failed",
                errorMessage: "nope",
                sentAt: undefined,
            }),
        ]);
    });

    it("does not schedule a successor when the adapter returns halt", async () => {
        const sender = fakeSender(async () => ({ halt: "template paused", nextDelayMs: 500 }));

        const { ctx, scheduled, mutations } = createCtx({
            campaign,
            batch,
            hasMoreBatches: true,
        });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        // Still marks the batch complete, but schedules nothing.
        expect(mutations.some((m) => m.name === "campaignBatches:markBatchComplete")).toBe(true);
        expect(scheduled).toEqual([]);
    });

    it("short-circuits a paused campaign before claiming a batch", async () => {
        const sendBatch = vi.fn();
        const sender = fakeSender(sendBatch as any);

        const { ctx, mutations } = createCtx({
            campaign: { _id: "c1", status: "paused" },
            batch,
        });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        expect(sendBatch).not.toHaveBeenCalled();
        expect(mutations).toEqual([]); // never even claims
    });

    it("returns without claiming when there is no pending batch", async () => {
        const sendBatch = vi.fn();
        const sender = fakeSender(sendBatch as any);

        const { ctx, mutations } = createCtx({ campaign, batch: null });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        expect(sendBatch).not.toHaveBeenCalled();
        expect(mutations).toEqual([]);
    });

    it("reschedules itself when it loses the claim race (unified rule)", async () => {
        const sendBatch = vi.fn();
        const sender = fakeSender(sendBatch as any);

        const { ctx, scheduled } = createCtx({ campaign, batch, acquired: false });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        expect(sendBatch).not.toHaveBeenCalled();
        expect(scheduled).toEqual([{ ms: 250, name: "campaignQueue:processEmailBatch" }]);
    });

    it("relies on the claim for the initial lease — does not beat within the first throttle window", async () => {
        // The claim's markBatchProcessing establishes a live heartbeat, so a batch
        // that emits a few results immediately (clock fixed within one window) must
        // not issue a redundant beatBatch. This is what "initial lease from claim"
        // means at the driver seam.
        const clock = 1_000_000;
        const sender = fakeSender(async (_ctx, _campaign, _batch, emit: EmitFn) => {
            for (let i = 0; i < 5; i++) await emit([{ recipientId: `r${i}`, success: true }]);
            return {};
        });

        const { ctx, mutations } = createCtx({ campaign, batch });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender, now: () => clock });

        expect(mutations.some((m) => m.name === "campaignBatches:beatBatch")).toBe(false);
    });

    it("beats at most once per throttle window across a stream of results, not once per result", async () => {
        // 60 emits spaced so the stream spans two throttle windows. The driver must
        // bound heartbeat writes to one per window (2 total), not one per result (60).
        let clock = 1_000_000;
        const step = HEARTBEAT_THROTTLE_MS / 30; // 60 emits → ~2 windows
        const sender = fakeSender(async (_ctx, _campaign, _batch, emit: EmitFn) => {
            for (let i = 0; i < 60; i++) {
                clock += step;
                await emit([{ recipientId: `r${i}`, success: true }]);
            }
            return {};
        });

        const { ctx, mutations } = createCtx({ campaign, batch });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender, now: () => clock });

        const beats = mutations.filter((m) => m.name === "campaignBatches:beatBatch");
        expect(beats.length).toBe(2);
        expect(beats.length).toBeLessThan(60);
        expect(beats[0].args).toEqual({ batchId: "batch-1" });
    });

    it("marks the batch failed and continues when the adapter throws, flushing partial progress", async () => {
        const sender = fakeSender(async (_ctx, _campaign, _batch, emit: EmitFn) => {
            await emit([{ recipientId: "a", success: true }]);
            throw new Error("boom");
        });

        const { ctx, updateBatches, scheduled, mutations } = createCtx({
            campaign,
            batch,
            hasMoreBatches: true,
        });

        await runChannelSend(ctx as any, { campaignId: "c1" as any, sender });

        // Partial progress is flushed before the failure is recorded.
        expect(updateBatches.flat()).toEqual([
            expect.objectContaining({ recipientId: "a", status: "sent" }),
        ]);
        // The batch is marked failed (not complete) and the channel reschedules.
        expect(mutations.some((m) => m.name === "campaignBatches:markBatchFailed")).toBe(true);
        expect(mutations.some((m) => m.name === "campaignBatches:markBatchComplete")).toBe(false);
        expect(scheduled).toEqual([{ ms: 10000, name: "campaignQueue:processEmailBatch" }]);
    });
});
