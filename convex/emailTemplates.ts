import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { checkAccessHelper } from "./users";

// List templates visible to the current user:
// - Admins see all templates
// - Regular users see shared templates (visibility !== "private") + their own private ones
export const list = query({
    args: {},
    handler: async (ctx) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const isAdmin = access.user.role === "admin";
        const currentUserId = access.user._id;

        const allTemplates = await ctx.db.query("emailTemplates").order("desc").collect();

        if (isAdmin) return allTemplates;

        return allTemplates.filter(
            (t) => t.visibility !== "private" || t.createdBy === currentUserId
        );
    },
});

// Get a single template by ID (respects visibility)
export const getById = query({
    args: {
        id: v.id("emailTemplates"),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const template = await ctx.db.get(args.id);
        if (!template) return null;

        const isAdmin = access.user.role === "admin";
        const isOwner = template.createdBy === access.user._id;

        if (template.visibility === "private" && !isAdmin && !isOwner) {
            throw new Error("Not authorized to view this template");
        }

        return template;
    },
});

// Create a new template — defaults to "private"
export const create = mutation({
    args: {
        name: v.string(),
        subject: v.string(),
        htmlContent: v.string(),
        fontSize: v.optional(v.string()),
        visibility: v.optional(v.union(v.literal("private"), v.literal("shared"))),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const id = await ctx.db.insert("emailTemplates", {
            name: args.name,
            subject: args.subject,
            htmlContent: args.htmlContent,
            fontSize: args.fontSize,
            createdBy: access.user._id,
            lastUpdatedAt: Date.now(),
            visibility: args.visibility ?? "private",
        });
        return id;
    },
});

// Update a template — only owner or admin
export const update = mutation({
    args: {
        id: v.id("emailTemplates"),
        name: v.optional(v.string()),
        subject: v.optional(v.string()),
        htmlContent: v.optional(v.string()),
        fontSize: v.optional(v.string()),
        visibility: v.optional(v.union(v.literal("private"), v.literal("shared"))),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const { id, ...updates } = args;
        const existing = await ctx.db.get(id);
        if (!existing) throw new Error("Template not found");

        const isAdmin = access.user.role === "admin";
        const isOwner = existing.createdBy === access.user._id;
        if (!isAdmin && !isOwner) throw new Error("Not authorized to edit this template");

        const filteredUpdates = Object.fromEntries(
            Object.entries(updates).filter(([, value]) => value !== undefined)
        );

        await ctx.db.patch(id, {
            ...filteredUpdates,
            lastUpdatedAt: Date.now(),
        });

        return id;
    },
});

// Delete a template — only owner or admin
export const remove = mutation({
    args: {
        id: v.id("emailTemplates"),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const existing = await ctx.db.get(args.id);
        if (!existing) throw new Error("Template not found");

        const isAdmin = access.user.role === "admin";
        const isOwner = existing.createdBy === access.user._id;
        if (!isAdmin && !isOwner) throw new Error("Not authorized to delete this template");

        await ctx.db.delete(args.id);
    },
});

// Toggle visibility — only owner or admin
export const setVisibility = mutation({
    args: {
        id: v.id("emailTemplates"),
        visibility: v.union(v.literal("private"), v.literal("shared")),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const existing = await ctx.db.get(args.id);
        if (!existing) throw new Error("Template not found");

        const isAdmin = access.user.role === "admin";
        const isOwner = existing.createdBy === access.user._id;
        if (!isAdmin && !isOwner) throw new Error("Not authorized to change visibility of this template");

        await ctx.db.patch(args.id, {
            visibility: args.visibility,
            lastUpdatedAt: Date.now(),
        });
    },
});
