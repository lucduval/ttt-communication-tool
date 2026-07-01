/**
 * Channel Send driver — write-rate-limit resilience (PRD #39, issue #43).
 *
 * Convex enforces a deployment-wide 4 MiB/s write ceiling. When the per-recipient
 * `messages.updateStatusBatch` flush trips that ceiling it throws `TooManyWrites`.
 * Two failure modes these tests pin:
 *   1. A flush that hits `TooManyWrites` must back off and retry the SAME buffer
 *      rather than failing the batch — a transient rate-limit window should not
 *      cost the campaign a batch.
 *   2. If a flush ultimately cannot be written, the batch must NOT be left
 *      stranded in `processing`: `handleBatchError` must still run so the batch
 *      ends failed/recoverable with a scheduled successor. In particular the
 *      catch-path's partial-progress flush must never re-throw past
 *      `handleBatchError`.
 *
 * The driver is the plain exported `runChannelSend`, so we drive it directly
 * against a faked `ctx` (mirrors `channelSend.test.ts`) with an injected `sleep`
 * so backoff costs no real wall-clock.
 */
import { describe, it, expect, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { runChannelSend, type ChannelSender, type EmitFn } from "../channelSend";

type Update = {
    recipientId: string;
    status: "sent" | "failed";
    sentAt?: number;
    errorMessage?: string;
    externalMessageId?: string;
};

class TooManyWritesError extends Error {
    constructor() {
        super(
            "TooManyWrites: Too many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second."
        );
        this.name = "TooManyWritesError";
    }
}

interface CtxOpts {
    hasMoreBatches?: boolean;
    /**
     * Decide whether the Nth (0-based) `updateStatusBatch` call should throw
     * `TooManyWrites`. Lets a test fail the first K flushes then recover, or fail
     * them all.
     */
    failFlush?: (callIndex: number) => boolean;
}

function createCtx(opts: CtxOpts) {
    const updateBatches: Update[][] = [];
    const scheduled: Array<{ ms: number; name: string }> = [];
    const mutations: Array<{ name: string; args: any }> = [];
    let flushCalls = 0;

    const ctx = {
        runQuery: vi.fn(async (ref: unknown) => {
            switch (getFunctionName(ref as any)) {
                case "campaignBatches:getCampaign":
                    return { _id: "c1", status: "active" };
                case "campaignBatches:getNextPendingBatchInternal":
                    return { _id: "batch-1", recipients: [] };
                case "messages:getExistingMessageStatuses":
                    return [];
                default:
                    return undefined;
            }
        }),
        runMutation: vi.fn(async (ref: unknown, args: any) => {
            const name = getFunctionName(ref as any);
            if (name === "messages:updateStatusBatch") {
                const idx = flushCalls++;
                if (opts.failFlush?.(idx)) throw new TooManyWritesError();
                updateBatches.push(args.updates);
                mutations.push({ name, args });
                return undefined;
            }
            mutations.push({ name, args });
            if (name === "campaignBatches:markBatchProcessing") return { acquired: true };
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

function fakeSender(sendBatch: ChannelSender["sendBatch"]): ChannelSender {
    return { channel: "email", errorRetryDelayMs: 10000, sendBatch };
}

describe("runChannelSend write-rate-limit resilience", () => {
    it("backs off and retries a flush that trips TooManyWrites, then completes the batch", async () => {
        // First flush attempt trips the write wall; the retry (after backoff) lands.
        const { ctx, updateBatches, mutations, scheduled } = createCtx({
            hasMoreBatches: true,
            failFlush: (idx) => idx === 0,
        });
        const slept: number[] = [];

        const sender = fakeSender(async (_c, _camp, _b, emit: EmitFn) => {
            await emit([{ recipientId: "a", success: true }]);
            return { nextDelayMs: 500 };
        });

        await runChannelSend(ctx as any, {
            campaignId: "c1" as any,
            sender,
            sleep: async (ms) => {
                slept.push(ms);
            },
        });

        // Backed off at least once before the retry succeeded.
        expect(slept.length).toBeGreaterThanOrEqual(1);
        // The recipient's progress was preserved (written on the retry).
        expect(updateBatches.flat()).toEqual([
            expect.objectContaining({ recipientId: "a", status: "sent" }),
        ]);
        // The batch completed normally — not stranded, not failed.
        expect(mutations.some((m) => m.name === "campaignBatches:markBatchComplete")).toBe(true);
        expect(mutations.some((m) => m.name === "campaignBatches:markBatchFailed")).toBe(false);
        expect(scheduled).toEqual([{ ms: 500, name: "campaignQueue:processEmailBatch" }]);
    });

    it("does not strand the batch when every flush trips TooManyWrites — runs handleBatchError", async () => {
        // The write wall never clears. The batch must still end recoverable:
        // markBatchFailed + a scheduled successor, never left in `processing`.
        const { ctx, mutations, scheduled } = createCtx({
            hasMoreBatches: true,
            failFlush: () => true,
        });

        const sender = fakeSender(async (_c, _camp, _b, emit: EmitFn) => {
            await emit([{ recipientId: "a", success: true }]);
            return {};
        });

        await runChannelSend(ctx as any, {
            campaignId: "c1" as any,
            sender,
            sleep: async () => {},
        });

        // Never marked complete; marked failed and a successor scheduled.
        expect(mutations.some((m) => m.name === "campaignBatches:markBatchComplete")).toBe(false);
        expect(mutations.some((m) => m.name === "campaignBatches:markBatchFailed")).toBe(true);
        expect(scheduled).toEqual([{ ms: 10000, name: "campaignQueue:processEmailBatch" }]);
    });

    it("catch-path flush that re-throws TooManyWrites still reaches handleBatchError", async () => {
        // Adapter throws *after* emitting, so the catch path runs. Its
        // partial-progress flush also trips the write wall and exhausts retries —
        // it must be swallowed so handleBatchError runs regardless.
        const { ctx, mutations, scheduled } = createCtx({
            hasMoreBatches: false,
            failFlush: () => true,
        });

        const sender = fakeSender(async (_c, _camp, _b, emit: EmitFn) => {
            await emit([{ recipientId: "a", success: true }]);
            throw new Error("adapter boom");
        });

        await runChannelSend(ctx as any, {
            campaignId: "c1" as any,
            sender,
            sleep: async () => {},
        });

        // handleBatchError ran despite the catch-path flush failing.
        expect(mutations.some((m) => m.name === "campaignBatches:markBatchFailed")).toBe(true);
        // No successor here (hasMoreBatches false) but the batch is not stranded.
        expect(scheduled).toEqual([]);
    });
});
