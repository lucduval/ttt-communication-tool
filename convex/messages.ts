import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

export const listByCampaign = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("messages")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .order("desc")
            .collect();
    },
});

export const getCampaignStats = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const messages = await ctx.db
            .query("messages")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();

        return {
            total: messages.length,
            pending: messages.filter((m) => m.status === "pending").length,
            sent: messages.filter((m) => m.status === "sent").length,
            delivered: messages.filter((m) => m.status === "delivered").length,
            failed: messages.filter((m) => m.status === "failed").length,
        };
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
                channel: v.union(v.literal("email"), v.literal("whatsapp")),
            })
        ),
    },
    handler: async (ctx, args) => {
        for (const message of args.messages) {
            await ctx.db.insert("messages", message);
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

