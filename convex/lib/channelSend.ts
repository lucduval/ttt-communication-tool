import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { batchProcessorFor, handleBatchError, type Channel } from "./channelDispatch";

/**
 * One per-recipient outcome streamed back to the Channel Send driver via `emit`.
 * The driver — not the adapter — turns these into the `messages.updateStatusBatch`
 * writes, so the status-write shape is identical across every channel.
 */
export type SendResult = {
    recipientId: string;
    success: boolean;
    error?: string;
    /** Provider message id (e.g. the WhatsApp wamid); omitted for channels without one. */
    externalMessageId?: string;
};

/** Push-based sink the adapter calls with results as it produces them. */
export type EmitFn = (results: SendResult[]) => Promise<void>;

/** The minimal campaign shape the driver hands to a Channel Sender. */
export type DriverBatch = {
    _id: Id<"campaignBatches">;
    recipients: Array<{ id: string; email?: string; phone?: string; name: string; variables?: string }>;
};

/**
 * The seam between the Channel Send driver and one channel. An adapter owns
 * only its channel's per-recipient send loop and side-effects: it calls `emit`
 * with results as it produces them and returns an optional `halt` reason
 * (stops the driver scheduling a successor) and an optional `nextDelayMs`
 * (successor delay). Crash-survival flushing is the driver's, not the adapter's.
 */
export interface ChannelSender {
    channel: Channel;
    /** Successor delay after a thrown error — per-channel pacing (email backs off further). */
    errorRetryDelayMs: number;
    sendBatch(
        ctx: ActionCtx,
        campaign: any,
        batch: DriverBatch,
        emit: EmitFn
    ): Promise<{ halt?: string; nextDelayMs?: number }>;
}

/**
 * Flush buffered per-recipient results to the DB every FLUSH_INTERVAL recipients
 * so partial progress survives an action crash/timeout. This is the reliability
 * guarantee the push-based interface exists to give every channel.
 */
export const FLUSH_INTERVAL = 25;

/**
 * The Channel Send driver. Owns the whole batch lifecycle independent of channel:
 * the paused-campaign short-circuit, fetching the next pending batch, claiming it
 * with the idempotency guard, buffering + flushing per-recipient results every
 * FLUSH_INTERVAL (and once at the end), marking the batch complete, scheduling the
 * successor with the adapter's `nextDelayMs` (unless it returned `halt`), the
 * unified lost-claim-race rule (reschedule to keep the worker pool stable), and
 * mark-failed-and-continue on a thrown error. The adapter contributes only its
 * channel's send loop via `sender.sendBatch`.
 */
export async function runChannelSend(
    ctx: ActionCtx,
    args: { campaignId: Id<"campaigns">; sender: ChannelSender }
): Promise<void> {
    const { campaignId, sender } = args;

    const campaign = await ctx.runQuery(internal.campaignBatches.getCampaign, { campaignId });
    if (!campaign) {
        console.error("Campaign not found:", campaignId);
        return;
    }

    if (campaign.status === "paused") {
        console.log("Campaign paused, stopping batch processing:", campaignId);
        return;
    }

    const batch = await ctx.runQuery(internal.campaignBatches.getNextPendingBatchInternal, {
        campaignId,
    });
    if (!batch) {
        console.log("No more batches to process for campaign:", campaignId);
        return;
    }

    const { acquired } = await ctx.runMutation(internal.campaignBatches.markBatchProcessing, {
        batchId: batch._id,
    });
    if (!acquired) {
        // Another parallel worker claimed this batch. Reschedule self to pick up
        // the next available batch, keeping the worker pool stable. This is the
        // unified lost-claim-race rule applied to every channel.
        await ctx.scheduler.runAfter(250, batchProcessorFor(sender.channel), { campaignId });
        return;
    }

    let successCount = 0;
    let failedCount = 0;
    const buffer: SendResult[] = [];

    const flush = async () => {
        if (buffer.length === 0) return;
        await ctx.runMutation(internal.messages.updateStatusBatch, {
            campaignId,
            updates: buffer.map((r) => ({
                recipientId: r.recipientId,
                status: r.success ? ("sent" as const) : ("failed" as const),
                sentAt: r.success ? Date.now() : undefined,
                errorMessage: r.error,
                externalMessageId: r.externalMessageId,
            })),
        });
        buffer.length = 0;
    };

    const emit: EmitFn = async (results) => {
        for (const r of results) {
            buffer.push(r);
            if (r.success) successCount++;
            else failedCount++;
            if (buffer.length >= FLUSH_INTERVAL) await flush();
        }
    };

    try {
        const { halt, nextDelayMs } = await sender.sendBatch(ctx, campaign, batch, emit);

        // Final flush of whatever is left in the buffer.
        await flush();

        const { hasMoreBatches } = await ctx.runMutation(
            internal.campaignBatches.markBatchComplete,
            { batchId: batch._id, successCount, failedCount }
        );

        if (halt) {
            console.error(`Campaign ${campaignId} halted: ${halt}`);
        } else if (hasMoreBatches) {
            await ctx.scheduler.runAfter(nextDelayMs ?? 0, batchProcessorFor(sender.channel), {
                campaignId,
            });
        }
    } catch (err) {
        // Persist partial progress before marking the batch failed so an
        // interrupted batch's sent/failed counts stay accurate.
        await flush();
        await handleBatchError(ctx, {
            channel: sender.channel,
            campaignId,
            batchId: batch._id,
            err,
            retryDelayMs: sender.errorRetryDelayMs,
        });
    }
}
