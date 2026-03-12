import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { checkAccessHelper } from "./users";

export const list = query({
    args: {},
    handler: async (ctx) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");

        if (!access.user) throw new Error("User not found");

        let campaigns;
        if (access.user.role === "admin") {
            campaigns = await ctx.db
                .query("campaigns")
                .order("desc")
                .collect();
        } else {
            campaigns = await ctx.db
                .query("campaigns")
                .withIndex("by_user", (q) => q.eq("createdBy", access.user!.clerkId!))
                .order("desc")
                .collect();
        }

        // Resolve creator names from users table
        const clerkIds = [...new Set(campaigns.map((c) => c.createdBy))];
        const userMap = new Map<string, { name?: string; email: string }>();
        for (const clerkId of clerkIds) {
            const user = await ctx.db
                .query("users")
                .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
                .first();
            userMap.set(clerkId, {
                name: user?.name,
                email: user?.email ?? "—",
            });
        }

        return campaigns.map((c) => ({
            ...c,
            creatorName: userMap.get(c.createdBy)?.name,
            creatorEmail: userMap.get(c.createdBy)?.email ?? "—",
        }));
    },
});

export const get = query({
    args: { id: v.id("campaigns") },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");

        return await ctx.db.get(args.id);
    },

});

export const search = query({
    args: { query: v.string() },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        if (!args.query) {
            return [];
        }

        if (access.user.role === "admin") {
            return await ctx.db
                .query("campaigns")
                .withSearchIndex("search_name", (q) => q.search("name", args.query))
                .take(10);
        }

        // Regular users only search within their own campaigns
        // Search index doesn't support complex filtering well, so we search and then filter in memory
        // since we only take 10 anyway, we might grab 50 and filter to 10.
        const allMatches = await ctx.db
            .query("campaigns")
            .withSearchIndex("search_name", (q) => q.search("name", args.query))
            .take(50);

        return allMatches.filter(c => c.createdBy === access.user!.clerkId).slice(0, 10);
    },
});

export const create = mutation({
    args: {
        name: v.string(),
        channel: v.union(v.literal("email"), v.literal("whatsapp")),
        totalRecipients: v.number(),
        subject: v.optional(v.string()), // Email subject
        templateId: v.optional(v.string()), // WhatsApp template ID
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");

        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthenticated");

        const campaignId = await ctx.db.insert("campaigns", {
            name: args.name,
            channel: args.channel,
            status: "processing",
            totalRecipients: args.totalRecipients,
            sentCount: 0,
            deliveredCount: 0,
            failedCount: 0,
            createdBy: identity.subject,
            subject: args.subject,
            templateId: args.templateId,
        });

        return campaignId;
    },
});

export const updateStats = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        sentCount: v.number(),
        deliveredCount: v.number(),
        failedCount: v.number(),
    },
    handler: async (ctx, args) => {
        const campaign = await ctx.db.get(args.campaignId);
        if (campaign) {
            await ctx.db.patch(args.campaignId, {
                sentCount: (campaign.sentCount || 0) + args.sentCount,
                deliveredCount: (campaign.deliveredCount || 0) + args.deliveredCount,
                failedCount: (campaign.failedCount || 0) + args.failedCount,
            });
        }
    },
});

export const updateStatus = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        status: v.string(),
    },
    handler: async (ctx, args) => {
        await ctx.db.patch(args.campaignId, { status: args.status });
    },
});

/**
 * Pause a running campaign. Stops processing of pending batches immediately.
 * Only admins or the campaign creator can pause.
 */
export const pauseCampaign = mutation({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const campaign = await ctx.db.get(args.campaignId);
        if (!campaign) throw new Error("Campaign not found");

        const isAdmin = access.user.role === "admin";
        const isCreator = campaign.createdBy === access.user.clerkId;
        if (!isAdmin && !isCreator) {
            throw new Error("Only the campaign creator or an admin can pause this campaign");
        }

        if (campaign.status !== "queued" && campaign.status !== "processing") {
            throw new Error(`Cannot pause campaign with status "${campaign.status}"`);
        }

        await ctx.db.patch(args.campaignId, { status: "paused" });

        await ctx.runMutation(internal.notifications.create, {
            userId: campaign.createdBy,
            title: "Campaign Paused",
            message: `Campaign "${campaign.name}" has been paused. Pending batches will not be sent.`,
            type: "warning",
            link: `/campaigns/${args.campaignId}`,
        });

        return { success: true };
    },
});

/**
 * Emergency pause - no auth required. Use from Convex Dashboard when you need
 * to stop a campaign immediately (Dashboard runs without user context).
 */
export const emergencyPauseCampaign = mutation({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const campaign = await ctx.db.get(args.campaignId);
        if (!campaign) throw new Error("Campaign not found");

        if (campaign.status !== "queued" && campaign.status !== "processing") {
            throw new Error(`Cannot pause campaign with status "${campaign.status}"`);
        }

        await ctx.db.patch(args.campaignId, { status: "paused" });

        await ctx.runMutation(internal.notifications.create, {
            userId: campaign.createdBy,
            title: "Campaign Paused",
            message: `Campaign "${campaign.name}" has been paused (emergency). Pending batches will not be sent.`,
            type: "warning",
            link: `/campaigns/${args.campaignId}`,
        });

        return { success: true };
    },
});
