import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { withWriteRetry } from "./writeRetry";

/** The three send channels a campaign can use. */
export type Channel = "email" | "whatsapp" | "personalised";

/**
 * Single source of truth mapping a campaign's channel to its batch-processing
 * worker. Replaces the three-way `if (channel === ...)` conditional that was
 * copy-pasted across the queue, scheduled-kickoff, filter-processing, resume,
 * and stuck-batch-recovery paths. Callers schedule the returned reference
 * themselves (`ctx.scheduler.runAfter(delay, batchProcessorFor(channel), ...)`),
 * so this works from both action and mutation contexts.
 */
export function batchProcessorFor(channel: Channel) {
    switch (channel) {
        case "personalised":
            return internal.campaignQueue.processPersonalisedBatch;
        case "email":
            return internal.campaignQueue.processEmailBatch;
        default:
            return internal.campaignQueue.processWhatsAppBatch;
    }
}

/**
 * Shared batch-error handler for the per-channel processors. Marks the current
 * batch failed and — if more batches remain — reschedules the same channel's
 * worker after `retryDelayMs`, so processing continues past a single batch's
 * failure. Replaces the near-identical catch blocks copy-pasted into each
 * processor (the only intended difference being the per-channel retry delay).
 */
export async function handleBatchError(
    ctx: ActionCtx,
    args: {
        channel: Channel;
        campaignId: Id<"campaigns">;
        batchId: Id<"campaignBatches">;
        err: unknown;
        retryDelayMs: number;
        /** Injectable so tests exercise the write-rate backoff without real wall-clock. */
        sleep?: (ms: number) => Promise<void>;
    }
): Promise<void> {
    console.error("Batch processing error:", args.err);
    const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // The error path itself must survive the write wall: if this mark-failed also
    // trips `TooManyWrites` and throws, the batch is stranded in `processing` with
    // no successor. Back off and retry it like every other driver write.
    const { hasMoreBatches } = await withWriteRetry(
        () =>
            ctx.runMutation(internal.campaignBatches.markBatchFailed, {
                batchId: args.batchId,
                errorMessage: args.err instanceof Error ? args.err.message : "Unknown error",
            }),
        sleep
    );

    if (hasMoreBatches) {
        await ctx.scheduler.runAfter(args.retryDelayMs, batchProcessorFor(args.channel), {
            campaignId: args.campaignId,
        });
    }
}
