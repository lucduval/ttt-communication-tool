import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";
import { checkAccessHelper } from "./users";

export const generateUploadUrl = mutation(async (ctx) => {
    const access = await checkAccessHelper(ctx);
    if (!access.hasAccess) throw new Error("Unauthorized");
    return await ctx.storage.generateUploadUrl();
});

export const getDownloadUrl = query({
    args: { storageId: v.id("_storage") },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");
        return await ctx.storage.getUrl(args.storageId);
    },
});

/** Internal-only: returns download URL without auth check. Used by campaign queue when processing batches (no user context). */
export const getDownloadUrlInternal = internalQuery({
    args: { storageId: v.id("_storage") },
    handler: async (ctx, args) => {
        return await ctx.storage.getUrl(args.storageId);
    },
});
