import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, query } from "./_generated/server";

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
        if (args.status && SERVER_FILTERABLE_STATUSES.includes(args.status)) {
            return await ctx.db
                .query("messages")
                .withIndex("by_campaign_status", (q) =>
                    q.eq("campaignId", args.campaignId).eq("status", args.status!)
                )
                .order("desc")
                .paginate(args.paginationOpts);
        }

        return await ctx.db
            .query("messages")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .order("desc")
            .paginate(args.paginationOpts);
    },
});

export const getCampaignStats = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const campaign = await ctx.db.get(args.campaignId);
        if (!campaign) return null;
        return {
            total: campaign.totalRecipients,
            sent: campaign.sentCount || 0,
            delivered: campaign.deliveredCount || 0,
            failed: campaign.failedCount || 0,
        };
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

