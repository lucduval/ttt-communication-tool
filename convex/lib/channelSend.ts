import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { batchProcessorFor, handleBatchError, type Channel } from "./channelDispatch";
import { shouldBeat } from "./batchLease";
import { eligibleRecipients } from "./sendEligibility";
import { isTooManyWrites, withWriteRetry } from "./writeRetry";

// Re-exported for existing importers/tests that reach for the write-rate helpers
// through the driver module.
export { isTooManyWrites, withWriteRetry };

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

/**
 * Driver-owned "handed to Graph" marker (PRD #55 / #58). The adapter calls it
 * with the recipient ids of a chunk *immediately before* the provider call; the
 * driver turns them into one idempotent `attempted` upsert (see
 * `messages.markAttemptedBatch`). The write shape lives in the driver so it is
 * identical across channels — the adapter owns only *when* it fires. Re-marking
 * an already-marked or settled recipient is a no-op, so a recovery re-run never
 * duplicates a row or regresses a status.
 */
export type MarkAttemptedFn = (recipientIds: string[]) => Promise<void>;

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
        emit: EmitFn,
        /**
         * The subset of `batch.recipients` eligible to send — those with no
         * existing `messages` row for the campaign, or a row still `pending`
         * (the seed createBatches writes up front, PRD #55 / #63). The driver
         * computes this once at batch start via the send-path eligibility rule
         * (the idempotency seam core, PRD #55 / #56), so a recipient already
         * handled — `attempted`/`sent`/`delivered`/`failed` — is never
         * auto-resent, while a fresh campaign still sends to everyone. Email
         * consumes this instead of re-querying; WhatsApp/personalised adopt it
         * in a later slice (#61) and for now still iterate `batch.recipients`.
         */
        eligible: DriverBatch["recipients"],
        /**
         * Driver-owned durable "handed to Graph" marker (PRD #55 / #58). The
         * adapter calls it with a chunk's recipient ids immediately BEFORE the
         * provider call; the driver writes the idempotent `attempted` rows. Email
         * calls it per ≤20 `$batch` chunk; WhatsApp/personalised adopt it in #61
         * and ignore it for now.
         */
        markAttempted: MarkAttemptedFn
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
    args: {
        campaignId: Id<"campaigns">;
        sender: ChannelSender;
        now?: () => number;
        /** Injectable for tests so flush backoff costs no real wall-clock. */
        sleep?: (ms: number) => Promise<void>;
    }
): Promise<void> {
    const {
        campaignId,
        sender,
        now = Date.now,
        sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    } = args;

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

    const { acquired } = await withWriteRetry(
        () =>
            ctx.runMutation(internal.campaignBatches.markBatchProcessing, {
                batchId: batch._id,
            }),
        sleep
    );
    if (!acquired) {
        // Another parallel worker claimed this batch. Reschedule self to pick up
        // the next available batch, keeping the worker pool stable. This is the
        // unified lost-claim-race rule applied to every channel.
        await ctx.scheduler.runAfter(250, batchProcessorFor(sender.channel), { campaignId });
        return;
    }

    // Send-path idempotency seam core (PRD #55 / #56 / #63): run the eligibility
    // query once at batch start and apply the pure rule. A recipient is eligible
    // iff it has no `messages` row for the campaign OR its row is still `pending`
    // (the seed createBatches writes up front), so a fresh campaign sends to all
    // its recipients while a recovery re-run never re-sends an already-handled
    // recipient (`attempted`/`sent`/`delivered`/`failed`). The adapter consumes
    // this eligible set instead of guarding for itself.
    const existingRows = await ctx.runQuery(internal.messages.getExistingMessageStatuses, {
        campaignId,
        recipientIds: batch.recipients.map((r) => r.id),
    });
    const eligible = eligibleRecipients(existingRows, batch.recipients);

    // Driver-owned "handed to Graph" marker (PRD #55 / #58). The adapter calls
    // this with a chunk's ids just before the provider call; the driver enriches
    // them from `batch.recipients` (so a freshly-inserted `attempted` row carries
    // the recipient's email/phone/name) and delegates to the one idempotent
    // upsert. The write shape stays here so it is identical across channels.
    const recipientById = new Map(batch.recipients.map((r) => [r.id, r]));
    const markAttempted: MarkAttemptedFn = async (recipientIds) => {
        if (recipientIds.length === 0) return;
        await withWriteRetry(
            () =>
                ctx.runMutation(internal.messages.markAttemptedBatch, {
                    campaignId,
                    channel: sender.channel,
                    recipients: recipientIds.map((id) => {
                        const r = recipientById.get(id);
                        return {
                            recipientId: id,
                            recipientEmail: r?.email,
                            recipientPhone: r?.phone,
                            recipientName: r?.name ?? "",
                        };
                    }),
                }),
            sleep
        );
    };

    let successCount = 0;
    let failedCount = 0;
    const buffer: SendResult[] = [];

    // The claim's markBatchProcessing has just set an initial heartbeat, so the
    // lease is already live. Seed lastBeatAt from it so a short batch that emits
    // within one throttle window does not issue a redundant beatBatch.
    let lastBeatAt = now();

    const flush = async () => {
        if (buffer.length === 0) return;
        const updates = buffer.map((r) => ({
            recipientId: r.recipientId,
            status: r.success ? ("sent" as const) : ("failed" as const),
            sentAt: r.success ? now() : undefined,
            errorMessage: r.error,
            externalMessageId: r.externalMessageId,
        }));
        // Retry the same buffer on a write-rate breach with growing backoff; only
        // clear the buffer once the write actually lands. A non-rate-limit error
        // (or an exhausted retry budget) propagates so the caller's catch can run
        // handleBatchError — the batch is never silently dropped.
        await withWriteRetry(
            () => ctx.runMutation(internal.messages.updateStatusBatch, { campaignId, updates }),
            sleep
        );
        buffer.length = 0;
    };

    // Serialise emit so adapters that send concurrently (e.g. WhatsApp's
    // Promise.all over recipients) cannot interleave a flush and double-write
    // or drop buffered results. The sends themselves stay concurrent; only the
    // buffer append + flush is ordered.
    let chain: Promise<void> = Promise.resolve();
    const emit: EmitFn = (results) => {
        chain = chain.then(async () => {
            for (const r of results) {
                buffer.push(r);
                if (r.success) successCount++;
                else failedCount++;
                if (buffer.length >= FLUSH_INTERVAL) await flush();
            }
            // Bump the lease as the adapter makes progress, throttled to ≤1 write
            // per ~30s so high-fan-out channels (WhatsApp up to 1000 results) and
            // per-recipient channels alike stay bounded. This is the driver's
            // responsibility — adapters never touch the heartbeat.
            const t = now();
            if (shouldBeat(lastBeatAt, t)) {
                lastBeatAt = t;
                await withWriteRetry(
                    () =>
                        ctx.runMutation(internal.campaignBatches.beatBatch, {
                            batchId: batch._id,
                        }),
                    sleep
                );
            }
        });
        return chain;
    };

    try {
        const { halt, nextDelayMs } = await sender.sendBatch(
            ctx,
            campaign,
            batch,
            emit,
            eligible,
            markAttempted
        );

        // Final flush of whatever is left in the buffer.
        await flush();

        const { hasMoreBatches } = await withWriteRetry(
            () =>
                ctx.runMutation(internal.campaignBatches.markBatchComplete, {
                    batchId: batch._id,
                    successCount,
                    failedCount,
                }),
            sleep
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
        // interrupted batch's sent/failed counts stay accurate. This flush is
        // best-effort: if it cannot land (e.g. the write wall is still up, even
        // after backoff), swallow that so handleBatchError ALWAYS runs and the
        // batch ends failed/recoverable with a successor — never stranded in
        // `processing` by a second flush that re-throws before the error handler.
        try {
            await flush();
        } catch (flushErr) {
            console.error("Failed to flush partial progress before batch error:", flushErr);
        }
        await handleBatchError(ctx, {
            channel: sender.channel,
            campaignId,
            batchId: batch._id,
            err,
            retryDelayMs: sender.errorRetryDelayMs,
            sleep,
        });
    }
}
