import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { checkAccessHelper } from "./users";

/**
 * Create a notification for a user (internal only)
 */
export const create = internalMutation({
    args: {
        userId: v.string(),
        title: v.string(),
        message: v.string(),
        type: v.string(), // info, success, warning, error
        link: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await ctx.db.insert("notifications", {
            userId: args.userId,
            title: args.title,
            message: args.message,
            type: args.type,
            link: args.link,
            isRead: false,
            createdAt: Date.now(),
        });
    },
});

/**
 * Get notifications for the current user
 */
export const list = query({
    args: {},
    handler: async (ctx) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) return [];

        return await ctx.db
            .query("notifications")
            .withIndex("by_user", (q) => q.eq("userId", access.user!.clerkId!)) // Use Clerk ID for user matching
            .order("desc")
            .take(20);
    },
});

/**
 * Get unread notification count
 */
export const getUnreadCount = query({
    args: {},
    handler: async (ctx) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) return 0;

        const notifications = await ctx.db
            .query("notifications")
            .withIndex("by_user_unread", (q) =>
                q.eq("userId", access.user!.clerkId!).eq("isRead", false)
            )
            .collect();

        return notifications.length;
    },
});

/**
 * Mark a notification as read
 */
export const markAsRead = mutation({
    args: { notificationId: v.id("notifications") },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const notification = await ctx.db.get(args.notificationId);
        if (!notification) return;

        // Verify ownership
        if (notification.userId !== access.user.clerkId) {
            throw new Error("Unauthorized");
        }

        await ctx.db.patch(args.notificationId, { isRead: true });
    },
});

/**
 * Mark all notifications as read for current user
 */
export const markAllAsRead = mutation({
    args: {},
    handler: async (ctx) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const unreadNotifications = await ctx.db
            .query("notifications")
            .withIndex("by_user_unread", (q) =>
                q.eq("userId", access.user!.clerkId!).eq("isRead", false)
            )
            .collect();

        for (const notif of unreadNotifications) {
            await ctx.db.patch(notif._id, { isRead: true });
        }
    },
});
