import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { checkAccessHelper } from "./users";

// List templates visible to the current user:
// - Admins see all templates
// - Regular users only see shared templates (visibility !== "private")
export const list = query({
    args: {
        status: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const isAdmin = access.user.role === "admin";

        let templates;
        if (args.status) {
            templates = await ctx.db
                .query("whatsappTemplates")
                .withIndex("by_status", (q) => q.eq("status", args.status!))
                .collect();
        } else {
            templates = await ctx.db.query("whatsappTemplates").collect();
        }

        if (isAdmin) return templates;

        return templates.filter((t) => t.visibility !== "private");
    },
});

// Get a single template by ID
export const getById = query({
    args: {
        id: v.id("whatsappTemplates"),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

        const template = await ctx.db.get(args.id);
        if (!template) return null;

        const isAdmin = access.user.role === "admin";
        if (template.visibility === "private" && !isAdmin) {
            throw new Error("Not authorized to view this template");
        }

        return template;
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

// Create a new template — admin only, defaults to "shared"
export const create = mutation({
    args: {
        name: v.string(),
        metaTemplateId: v.string(),
        category: v.string(),
        status: v.string(),
        body: v.string(),
        variables: v.array(v.string()),
        variableMappings: v.optional(v.string()),
        language: v.string(),
        headerType: v.optional(v.string()),
        headerText: v.optional(v.string()),
        headerUrl: v.optional(v.string()),
        visibility: v.optional(v.union(v.literal("private"), v.literal("shared"))),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user || access.user.role !== "admin") {
            throw new Error("Unauthorized");
        }

        const { visibility, ...rest } = args;
        const id = await ctx.db.insert("whatsappTemplates", {
            ...rest,
            createdBy: access.user._id,
            visibility: visibility ?? "shared",
            lastUpdatedAt: Date.now(),
        });
        return id;
    },
});

// Update an existing template — admin only
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
        visibility: v.optional(v.union(v.literal("private"), v.literal("shared"))),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user || access.user.role !== "admin") {
            throw new Error("Unauthorized");
        }

        const { id, ...updates } = args;
        const existing = await ctx.db.get(id);
        if (!existing) throw new Error("Template not found");

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

// Delete a template — admin only
export const remove = mutation({
    args: {
        id: v.id("whatsappTemplates"),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user || access.user.role !== "admin") {
            throw new Error("Unauthorized");
        }

        await ctx.db.delete(args.id);
    },
});

// Toggle visibility — admin only
export const setVisibility = mutation({
    args: {
        id: v.id("whatsappTemplates"),
        visibility: v.union(v.literal("private"), v.literal("shared")),
    },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || !access.user || access.user.role !== "admin") {
            throw new Error("Unauthorized");
        }

        const existing = await ctx.db.get(args.id);
        if (!existing) throw new Error("Template not found");

        await ctx.db.patch(args.id, {
            visibility: args.visibility,
            lastUpdatedAt: Date.now(),
        });
    },
});
