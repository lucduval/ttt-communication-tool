import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { checkAccessHelper } from "./users";

// List all templates
export const list = query({
    args: {},
    handler: async (ctx) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        return await ctx.db.query("emailTemplates").order("desc").collect();
    },
});

// Get a single template by ID
export const getById = query({
    args: {
        id: v.id("emailTemplates"),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        return await ctx.db.get(args.id);
    },
});

// Create a new template
export const create = mutation({
    args: {
        name: v.string(),
        subject: v.string(),
        htmlContent: v.string(),
        fontSize: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const id = await ctx.db.insert("emailTemplates", {
            ...args,
            createdBy: access.user._id,
            lastUpdatedAt: Date.now(),
        });
        return id;
    },
});

// Update an existing template
export const update = mutation({
    args: {
        id: v.id("emailTemplates"),
        name: v.optional(v.string()),
        subject: v.optional(v.string()),
        htmlContent: v.optional(v.string()),
        fontSize: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const { id, ...updates } = args;
        const existing = await ctx.db.get(id);
        if (!existing) {
            throw new Error("Template not found");
        }

        // Filter out undefined values
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

// Delete a template
export const remove = mutation({
    args: {
        id: v.id("emailTemplates"),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        await ctx.db.delete(args.id);
    },
});
