import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { Id, Doc } from "./_generated/dataModel";

export const logClick = internalMutation({
    args: {
        campaignId: v.string(),
        recipientId: v.string(),
        url: v.string(),
        userAgent: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        // Validate campaignId format manually to prevent crashes on invalid IDs
        let campaignId: Id<"campaigns">;
        try {
            // Check if it looks like a valid ID (simplified check, real check is ctx.db.normalizeId if available or just try/catch)
            // convex IDs are base32 strings.
            const normalization = ctx.db.normalizeId("campaigns", args.campaignId);
            if (!normalization) {
                console.warn(`Invalid campaignId logged for click: ${args.campaignId}`);
                return;
            }
            campaignId = normalization;
        } catch (e) {
            console.warn(`Error normalizing campaignId for click: ${args.campaignId}`, e);
            return;
        }

        // Check if this click is already logged to avoid double counting unique clicks if desired
        // For now, simpler to just log every click as an event.
        // Ideally we want unique clicks for the count on the dashboard.
        const existingClick = await ctx.db
            .query("clicks")
            .withIndex("by_recipient", (q) => q.eq("recipientId", args.recipientId))
            .filter((q) => q.eq(q.field("campaignId"), campaignId))
            .first();

        await ctx.db.insert("clicks", {
            campaignId: campaignId,
            recipientId: args.recipientId,
            url: args.url,
            clickedAt: Date.now(),
            userAgent: args.userAgent,
        });

        // Increment campaign clicks count if this is the first click from this recipient
        if (!existingClick) {
            const campaign = (await ctx.db.get(campaignId)) as Doc<"campaigns">;
            if (campaign) {
                await ctx.db.patch(campaignId, {
                    clicksCount: (campaign.clicksCount || 0) + 1,
                });
            }
        }
    },
});

export const logOpen = internalMutation({
    args: {
        campaignId: v.string(),
        recipientId: v.string(),
        userAgent: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        // Validate campaignId format manually
        let campaignId: Id<"campaigns">;
        try {
            const normalization = ctx.db.normalizeId("campaigns", args.campaignId);
            if (!normalization) {
                console.warn(`Invalid campaignId logged for open: ${args.campaignId}`);
                return;
            }
            campaignId = normalization;
        } catch (e) {
            console.warn(`Error normalizing campaignId for open: ${args.campaignId}`, e);
            return;
        }

        const existingOpen = await ctx.db
            .query("opens")
            .withIndex("by_recipient", (q) => q.eq("recipientId", args.recipientId))
            .filter((q) => q.eq(q.field("campaignId"), campaignId))
            .first();

        await ctx.db.insert("opens", {
            campaignId: campaignId,
            recipientId: args.recipientId,
            openedAt: Date.now(),
            userAgent: args.userAgent,
        });

        // Increment campaign opens count if this is the first open from this recipient
        if (!existingOpen) {
            const campaign = (await ctx.db.get(campaignId)) as Doc<"campaigns">;
            if (campaign) {
                await ctx.db.patch(campaignId, {
                    opensCount: (campaign.opensCount || 0) + 1,
                });
            }
        }
    },
});
