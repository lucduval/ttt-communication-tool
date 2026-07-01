import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { tallyCampaign } from "./lib/campaignTally";

// Statuses that can be filtered server-side via the by_campaign_status index.
// "opened" and "clicked" are engagement states, not message statuses, so they
// are handled client-side after loading the full paginated set.
const SERVER_FILTERABLE_STATUSES = ["pending", "sent", "delivered", "failed"];

export const listByCampaign = query({
    args: {
        campaignId: v.id("campaigns"),
        paginationOpts: paginationOptsValidator,
        status: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const useStatusIndex = !!(args.status && SERVER_FILTERABLE_STATUSES.includes(args.status));
        const baseQuery = useStatusIndex
            ? ctx.db
                .query("messages")
                .withIndex("by_campaign_status", (q) =>
                    q.eq("campaignId", args.campaignId).eq("status", args.status!)
                )
                .order("desc")
            : ctx.db
                .query("messages")
                .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
                .order("desc");

        return await baseQuery.paginate(args.paginationOpts);
    },
});

/**
 * Derive campaign stats from the messages table (source of truth) rather than
 * the denormalized counters on the campaign document, which can drift due to
 * batch recovery, double-counting, or partial flushes.
 *
 * Definitions:
 *   total     – campaign.totalRecipients (set at creation / filter resolution)
 *   sent      – messages with status "sent" (email accepted by Graph API)
 *   delivered – messages with status "delivered" (confirmed delivery)
 *   failed    – messages with status "failed"  (send error or bounce)
 *   pending   – messages with status "pending" (not yet attempted)
 */
export const getCampaignStats = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const campaign = await ctx.db.get(args.campaignId);
        if (!campaign) return null;

        // Recount from the messages table (source of truth) and apply the
        // Campaign Tally — the single seam that owns the count definitions, so
        // detail and (later) the list projection cannot diverge.
        const messages = await ctx.db
            .query("messages")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();

        return {
            total: campaign.totalRecipients,
            ...tallyCampaign(messages.map((m) => m.status)),
        };
    },
});

/**
 * Fetch messages for all recipients who opened or clicked in a campaign.
 * Looks up engagement records first, then resolves each message via the
 * by_campaign_recipient index — avoids scanning the full messages table.
 */
export const listByEngagement = query({
    args: {
        campaignId: v.id("campaigns"),
        engagement: v.union(v.literal("opened"), v.literal("clicked")),
    },
    handler: async (ctx, args) => {
        const tableName = args.engagement === "clicked" ? "clicks" : "opens";
        const records = await ctx.db
            .query(tableName)
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();

        const recipientIds = [...new Set(records.map((r) => r.recipientId))];

        const messages = await Promise.all(
            recipientIds.map((recipientId) =>
                ctx.db
                    .query("messages")
                    .withIndex("by_campaign_recipient", (q) =>
                        q.eq("campaignId", args.campaignId).eq("recipientId", recipientId)
                    )
                    .first()
            )
        );

        return messages.filter((m): m is NonNullable<typeof m> => m !== null);
    },
});

export const getEngagementRecipients = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const opens = await ctx.db
            .query("opens")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();

        const clicks = await ctx.db
            .query("clicks")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();

        const openedIds = [...new Set(opens.map((o) => o.recipientId))];
        const clickedIds = [...new Set(clicks.map((c) => c.recipientId))];

        return { openedIds, clickedIds };
    },
});

export const getFailedMessages = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("messages")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .filter((q) => q.eq(q.field("status"), "failed")) // or use by_status index if we had campaign+status index, but filter is fine for typically low volume of fails per campaign relative to total? Actually we have by_campaign_status index!
            // Wait, schema says: .index("by_campaign_status", ["campaignId", "status"]) on campaignBatches, 
            // but on messages table we have:
            // .index("by_campaign", ["campaignId"])
            // .index("by_campaign_recipient", ["campaignId", "recipientId"])
            // .index("by_status", ["status"])
            // So we don't have a compound index for campaign+status on messages.
            // efficient way is to use by_campaign and filter.
            .collect();
    },
});

export const createBatch = internalMutation({
    args: {
        messages: v.array(
            v.object({
                campaignId: v.id("campaigns"),
                recipientId: v.string(),
                recipientEmail: v.optional(v.string()),
                recipientPhone: v.optional(v.string()),
                recipientName: v.string(),
            status: v.string(),
            channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("personalised")),
            })
        ),
    },
    handler: async (ctx, args) => {
        for (const message of args.messages) {
            const existing = await ctx.db
                .query("messages")
                .withIndex("by_campaign_recipient", (q) =>
                    q.eq("campaignId", message.campaignId).eq("recipientId", message.recipientId)
                )
                .first();
            if (!existing) {
                await ctx.db.insert("messages", message);
            }
        }
    },
});

/**
 * Return the existing `messages` rows (recipientId + status) for the given
 * campaign recipients. This is the query behind the send-path eligibility rule
 * (PRD #55, slice #56): a recipient is eligible to send iff it has NO row here,
 * in ANY status. The Channel Send driver runs this once at batch start and
 * hands the pure `eligibleRecipients` rule (convex/lib/sendEligibility.ts) the
 * result, so a recipient recorded in any state — including `attempted` and a
 * terminal `failed` — is never auto-resent. This replaces the old
 * sent/delivered-only guard, which re-sent `failed` recipients on recovery.
 *
 * Scoped to the current batch's `recipientIds` and served O(1) per recipient
 * via the by_campaign_recipient index, avoiding an unbounded `.collect()` that
 * would hit Convex query limits once a campaign has sent ~8-10k messages.
 */
export const getExistingMessageStatuses = internalQuery({
    args: {
        campaignId: v.id("campaigns"),
        recipientIds: v.array(v.string()),
    },
    handler: async (ctx, args) => {
        const rows: Array<{ recipientId: string; status: string }> = [];
        for (const recipientId of args.recipientIds) {
            const msg = await ctx.db
                .query("messages")
                .withIndex("by_campaign_recipient", (q) =>
                    q.eq("campaignId", args.campaignId).eq("recipientId", recipientId)
                )
                .first();
            if (msg) rows.push({ recipientId, status: msg.status });
        }
        return rows;
    },
});

/**
 * Idempotent "handed to Graph" marker write — the durable `attempted` row the
 * email path previously lacked (PRD #55, slice #58). The Channel Send driver owns
 * this write shape so it is identical across channels; the adapter owns only
 * *when* it fires (email: once per ≤20 `$batch` chunk, immediately before the
 * Graph call).
 *
 * Upsert keyed by (campaignId, recipientId):
 *   - no row              → insert a fresh `attempted` row
 *   - existing `pending`  → advance to `attempted` (forward progress, not a
 *                           regression — `pending` means "not yet attempted")
 *   - any other status    → no-op (never regress a settled `sent`/`delivered`/
 *                           `failed`, never duplicate an existing `attempted`)
 *
 * So a recovery re-run that re-marks an already-marked or already-settled
 * recipient is a no-op — never a duplicate row, never a status regression. This
 * is what bounds a mid-batch worker crash to at most one chunk (≤20) stranded in
 * `attempted`, which the eligibility rule (#56) then declines to auto-resend.
 */
export async function markAttemptedBatchImpl(
    ctx: { db: any },
    args: {
        campaignId: Id<"campaigns">;
        channel: "email" | "whatsapp" | "personalised";
        recipients: Array<{
            recipientId: string;
            recipientEmail?: string;
            recipientPhone?: string;
            recipientName: string;
        }>;
    }
): Promise<void> {
    for (const r of args.recipients) {
        const existing = await ctx.db
            .query("messages")
            .withIndex("by_campaign_recipient", (q: any) =>
                q.eq("campaignId", args.campaignId).eq("recipientId", r.recipientId)
            )
            .first();

        if (!existing) {
            await ctx.db.insert("messages", {
                campaignId: args.campaignId,
                recipientId: r.recipientId,
                recipientEmail: r.recipientEmail,
                recipientPhone: r.recipientPhone,
                recipientName: r.recipientName,
                status: "attempted",
                channel: args.channel,
            });
        } else if (existing.status === "pending") {
            await ctx.db.patch(existing._id, { status: "attempted" });
        }
        // else: already `attempted` or settled — no-op (no dup row, no regression).
    }
}

export const markAttemptedBatch = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        channel: v.union(
            v.literal("email"),
            v.literal("whatsapp"),
            v.literal("personalised")
        ),
        recipients: v.array(
            v.object({
                recipientId: v.string(),
                recipientEmail: v.optional(v.string()),
                recipientPhone: v.optional(v.string()),
                recipientName: v.string(),
            })
        ),
    },
    handler: async (ctx, args) => markAttemptedBatchImpl(ctx, args),
});

// Batch update message statuses - much more efficient than per-message updates
export const updateStatusBatch = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        updates: v.array(
            v.object({
                recipientId: v.string(),
                status: v.string(),
                sentAt: v.optional(v.number()),
                errorMessage: v.optional(v.string()),
                externalMessageId: v.optional(v.string()),
            })
        ),
    },
    handler: async (ctx, args) => {
        // Use the new compound index for faster lookups
        for (const update of args.updates) {
            const message = await ctx.db
                .query("messages")
                .withIndex("by_campaign_recipient", (q) =>
                    q.eq("campaignId", args.campaignId).eq("recipientId", update.recipientId)
                )
                .first();

            if (message) {
                await ctx.db.patch(message._id, {
                    status: update.status,
                    sentAt: update.sentAt,
                    errorMessage: update.errorMessage,
                    externalMessageId: update.externalMessageId,
                });
            }
        }
    },
});

// Internal mutation to update message status (called by webhooks and actions)
export const updateMessageStatus = internalMutation({
    args: {
        externalMessageId: v.string(),
        status: v.string(),
        errorMessage: v.optional(v.string()),
        deliveredAt: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const message = await ctx.db
            .query("messages")
            .withIndex("by_external_id", (q) => q.eq("externalMessageId", args.externalMessageId))
            .first();

        if (message) {
            await ctx.db.patch(message._id, {
                status: args.status,
                errorMessage: args.errorMessage,
                deliveredAt: args.deliveredAt,
            });
        }
    },
});

export const updateStatusByRecipient = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        recipientId: v.string(),
        status: v.string(),
        sentAt: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        externalMessageId: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        // Use new compound index for faster lookup
        const message = await ctx.db
            .query("messages")
            .withIndex("by_campaign_recipient", (q) =>
                q.eq("campaignId", args.campaignId).eq("recipientId", args.recipientId)
            )
            .first();

        if (message) {
            await ctx.db.patch(message._id, {
                status: args.status,
                sentAt: args.sentAt,
                errorMessage: args.errorMessage,
                externalMessageId: args.externalMessageId,
            });
        }
    },
});

/** Return messages that have a Dynamics opportunity linked, for a given campaign. */
export const listOpportunityMessages = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const messages = await ctx.db
            .query("messages")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();

        return messages
            .filter((m) => !!m.opportunityId)
            .map((m) => ({ recipientId: m.recipientId, opportunityId: m.opportunityId! }));
    },
});

/** Store the Dynamics opportunity ID on a message record after creation. */
export const setOpportunityId = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        recipientId: v.string(),
        opportunityId: v.string(),
    },
    handler: async (ctx, args) => {
        const message = await ctx.db
            .query("messages")
            .withIndex("by_campaign_recipient", (q) =>
                q.eq("campaignId", args.campaignId).eq("recipientId", args.recipientId)
            )
            .first();

        if (message) {
            await ctx.db.patch(message._id, { opportunityId: args.opportunityId });
        }
    },
});

/**
 * List messages that have an opportunity linked, sent before a cutoff time,
 * and with no open or click recorded. Used by the cold-status cron job.
 */
export const listUnengagedOpportunityMessages = internalQuery({
    args: {
        sentBefore: v.number(), // timestamp in ms
        limit: v.number(),
    },
    handler: async (ctx, args) => {
        const messages = await ctx.db
            .query("messages")
            .withIndex("by_status", (q) => q.eq("status", "sent"))
            .filter((q) =>
                q.and(
                    q.neq(q.field("opportunityId"), undefined),
                    q.lt(q.field("sentAt"), args.sentBefore)
                )
            )
            .take(args.limit);

        // Filter out messages that have been opened or clicked
        const unengaged = [];
        for (const msg of messages) {
            if (!msg.opportunityId) continue;

            const campaignId = msg.campaignId;
            const recipientId = msg.recipientId;

            const hasOpen = await ctx.db
                .query("opens")
                .withIndex("by_campaign_recipient", (q) =>
                    q.eq("campaignId", campaignId).eq("recipientId", recipientId)
                )
                .first();

            if (hasOpen) continue;

            const hasClick = await ctx.db
                .query("clicks")
                .withIndex("by_campaign_recipient", (q) =>
                    q.eq("campaignId", campaignId).eq("recipientId", recipientId)
                )
                .first();

            if (hasClick) continue;

            unengaged.push({ messageId: msg._id, opportunityId: msg.opportunityId });
        }

        return unengaged;
    },
});

