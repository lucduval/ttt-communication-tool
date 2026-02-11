import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { checkAccessHelper, checkAdminAccess } from "./users";

// List all templates, optionally filtered by status
export const list = query({
    args: {
        status: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");

        if (args.status) {
            return await ctx.db
                .query("whatsappTemplates")
                .withIndex("by_status", (q) => q.eq("status", args.status!))
                .collect();
        }
        return await ctx.db.query("whatsappTemplates").collect();
    },
});

// Get a single template by ID
export const getById = query({
    args: {
        id: v.id("whatsappTemplates"),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");

        return await ctx.db.get(args.id);
    },
});

// Internal version for use in actions
export const getByIdInternal = internalQuery({
    args: {
        id: v.id("whatsappTemplates"),
    },
    handler: async (ctx, args) => {
        return await ctx.db.get(args.id);
    },
});

// Create a new template
export const create = mutation({
    args: {
        name: v.string(),
        metaTemplateId: v.string(),
        category: v.string(),
        status: v.string(),
        body: v.string(),
        variables: v.array(v.string()),
        variableMappings: v.optional(v.string()), // JSON stringified mapping
        language: v.string(),
        headerType: v.optional(v.string()), // none, text, image, document, video
        headerText: v.optional(v.string()),
        headerUrl: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await checkAdminAccess(ctx);
        if (!access) throw new Error("Unauthorized");

        const id = await ctx.db.insert("whatsappTemplates", {
            ...args,
            lastUpdatedAt: Date.now(),
        });
        return id;
    },
});

// Update an existing template
export const update = mutation({
    args: {
        id: v.id("whatsappTemplates"),
        name: v.optional(v.string()),
        metaTemplateId: v.optional(v.string()),
        category: v.optional(v.string()),
        status: v.optional(v.string()),
        body: v.optional(v.string()),
        variables: v.optional(v.array(v.string())),
        variableMappings: v.optional(v.string()),
        language: v.optional(v.string()),
        headerType: v.optional(v.string()),
        headerText: v.optional(v.string()),
        headerUrl: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await checkAdminAccess(ctx);
        if (!access) throw new Error("Unauthorized");

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
        id: v.id("whatsappTemplates"),
    },
    handler: async (ctx, args) => {
        const access = await checkAdminAccess(ctx);
        if (!access) throw new Error("Unauthorized");

        await ctx.db.delete(args.id);
    },
});
