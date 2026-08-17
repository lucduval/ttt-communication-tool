import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { checkAccessHelper } from "./users";

/**
 * Managed disclaimer collection (PRD #74). Mirrors the emailTemplates module:
 * named, org-shared, access-checked. The one deliberate divergence is deletion —
 * disclaimers are *archived* (a flag), never hard-deleted, so a past campaign that
 * referenced one stays meaningful. The operator-facing list excludes archived
 * disclaimers; resolution by id still returns an archived disclaimer.
 *
 * Handlers delegate to exported `*Impl` functions so the list/resolve/archive
 * behaviour is unit-testable against a faked `ctx` (see startCampaignImpl).
 */

// List active (non-archived) disclaimers, newest first. Any authenticated,
// active user may read the managed set — there is no per-disclaimer visibility.
export async function listImpl(ctx: any) {
    const access = await checkAccessHelper(ctx);
    if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

    const all = await ctx.db.query("disclaimers").order("desc").collect();
    return all.filter((d: any) => !d.archived);
}

export const list = query({
    args: {},
    handler: listImpl,
});

// Resolve a single disclaimer by id — returns it even when archived, so historical
// campaigns that reference an archived disclaimer stay resolvable.
export async function getByIdImpl(ctx: any, args: any) {
    const access = await checkAccessHelper(ctx);
    if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

    return await ctx.db.get(args.id);
}

export const getById = query({
    args: {
        id: v.id("disclaimers"),
    },
    handler: getByIdImpl,
});

export async function createImpl(ctx: any, args: any) {
    const access = await checkAccessHelper(ctx);
    if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

    return await ctx.db.insert("disclaimers", {
        name: args.name,
        htmlContent: args.htmlContent,
        isDefault: args.isDefault,
        createdBy: access.user._id,
        lastUpdatedAt: Date.now(),
    });
}

export const create = mutation({
    args: {
        name: v.string(),
        htmlContent: v.string(),
        isDefault: v.optional(v.boolean()),
    },
    handler: createImpl,
});

// Update a disclaimer — only owner or admin, mirroring emailTemplates.update.
export async function updateImpl(ctx: any, args: any) {
    const access = await checkAccessHelper(ctx);
    if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

    const { id, ...updates } = args;
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("Disclaimer not found");

    const isAdmin = access.user.role === "admin";
    const isOwner = existing.createdBy === access.user._id;
    if (!isAdmin && !isOwner) throw new Error("Not authorized to edit this disclaimer");

    const filteredUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, value]) => value !== undefined)
    );

    await ctx.db.patch(id, {
        ...filteredUpdates,
        lastUpdatedAt: Date.now(),
    });

    return id;
}

export const update = mutation({
    args: {
        id: v.id("disclaimers"),
        name: v.optional(v.string()),
        htmlContent: v.optional(v.string()),
        isDefault: v.optional(v.boolean()),
    },
    handler: updateImpl,
});

// Archive a disclaimer — sets a flag (no hard delete). Only owner or admin.
export async function archiveImpl(ctx: any, args: any) {
    const access = await checkAccessHelper(ctx);
    if (!access.hasAccess || !access.user) throw new Error("Unauthorized");

    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Disclaimer not found");

    const isAdmin = access.user.role === "admin";
    const isOwner = existing.createdBy === access.user._id;
    if (!isAdmin && !isOwner) throw new Error("Not authorized to archive this disclaimer");

    await ctx.db.patch(args.id, {
        archived: true,
        lastUpdatedAt: Date.now(),
    });

    return args.id;
}

export const archive = mutation({
    args: {
        id: v.id("disclaimers"),
    },
    handler: archiveImpl,
});
