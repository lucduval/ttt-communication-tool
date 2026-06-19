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
}

function createCtx(opts: CtxOpts) {
    const updateBatches: Update[][] = [];
    const scheduled: Array<{ ms: number; name: string }> = [];
    const mutations: Array<{ name: string; args: any }> = [];

    const ctx = {
        runQuery: vi.fn(async (ref: unknown) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getCampaign":
                    return opts.campaign;
                case "campaignBatches:getNextPendingBatchInternal":
                    return opts.batch;
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
