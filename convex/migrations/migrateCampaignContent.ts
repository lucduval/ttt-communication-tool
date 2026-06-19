import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Migration: Move heavy content fields from `campaigns` docs to `campaignContent`.
 *
 * Old campaigns stored htmlBody, attachments, content, filters, filterCriteria,
 * variableValues, aiPrompt, aiSystemPrompt, and fontSize directly on the
 * campaign document.  This bloats every query that scans campaigns (dashboard,
 * list) because Convex always returns full documents.
 *
 * This mutation:
 *  1. Finds campaigns that still carry heavy inline fields.
 *  2. Creates a `campaignContent` row for each (if one doesn't already exist).
 *  3. Patches the campaign to remove those fields.
 *
 * It processes a configurable batch size per invocation so it stays well within
 * Convex mutation limits.  Call it repeatedly (or via a scheduled action) until
 * it returns `{ migrated: 0, done: true }`.
 *
 * Safe to re-run — it is fully idempotent.
 */

const HEAVY_FIELDS = [
    "htmlBody",
    "attachments",
    "content",
    "filters",
    "filterCriteria",
    "variableValues",
    "aiPrompt",
    "aiSystemPrompt",
    "fontSize",
] as const;

export const migrateBatch = internalMutation({
    args: {
        batchSize: v.optional(v.number()), // default 3 — kept very small; newest campaigns are ~163KB each
        skip: v.optional(v.number()),      // number of campaigns already processed (from newest)
    },
    handler: async (ctx, args) => {
        const batchSize = args.batchSize ?? 3;
        const skip = args.skip ?? 0;

        // Process newest campaigns first (desc order) — these are the heavy ones.
        // Already-migrated campaigns at the front are now tiny, so re-reading
        // them on subsequent runs is cheap.
        const campaigns = await ctx.db
            .query("campaigns")
            .order("desc")
            .take(skip + batchSize);

        const batch = campaigns.slice(skip);

        if (batch.length === 0) {
            return { migrated: 0, skipped: 0, done: true, nextSkip: skip };
        }

        let migrated = 0;
        let skipped = 0;

        for (const campaign of batch) {
            const doc = campaign as Record<string, any>;

            // Check if this campaign has any heavy fields present
            const hasHeavyFields = HEAVY_FIELDS.some(
                (f) => doc[f] !== undefined && doc[f] !== null
            );

            if (!hasHeavyFields) {
                skipped++;
                continue;
            }

            // Check if a campaignContent row already exists
            const existing = await ctx.db
                .query("campaignContent")
                .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
                .first();

            if (!existing) {
                // Create the campaignContent row with all heavy fields
                await ctx.db.insert("campaignContent", {
                    campaignId: campaign._id,
                    htmlBody: doc.htmlBody ?? undefined,
                    attachments: doc.attachments ?? undefined,
                    content: doc.content ?? undefined,
                    filters: doc.filters ?? undefined,
                    filterCriteria: doc.filterCriteria ?? undefined,
                    variableValues: doc.variableValues ?? undefined,
                    aiPrompt: doc.aiPrompt ?? undefined,
                    aiSystemPrompt: doc.aiSystemPrompt ?? undefined,
                    fontSize: doc.fontSize ?? undefined,
                });
            }

            // Null out heavy fields on the campaign doc.
            // Convex patch with `undefined` removes the field.
            await ctx.db.patch(campaign._id, {
                htmlBody: undefined,
                attachments: undefined,
                content: undefined,
                filters: undefined,
                filterCriteria: undefined,
                variableValues: undefined,
                aiPrompt: undefined,
                aiSystemPrompt: undefined,
                fontSize: undefined,
            } as any);

            migrated++;
        }

        const nextSkip = skip + batch.length;
        const done = batch.length < batchSize;

        return { migrated, skipped, done, nextSkip };
    },
});

/**
 * Diagnostic: isolate which DB read in getDashboardStats causes the byte bloat.
 * Each test reads only one thing so we can see which triggers the warning.
 */
export const diagnoseCampaignReads = internalMutation({
    args: {
        test: v.union(
            v.literal("take50"),
            v.literal("take100"),
            v.literal("take120"),
            v.literal("take200"),
            v.literal("collect"),
        ),
    },
    handler: async (ctx, args) => {
        let campaigns;
        switch (args.test) {
            case "take50":
                campaigns = await ctx.db.query("campaigns").order("desc").take(50);
                break;
            case "take100":
                campaigns = await ctx.db.query("campaigns").order("desc").take(100);
                break;
            case "take120":
                campaigns = await ctx.db.query("campaigns").order("desc").take(120);
                break;
            case "take200":
                campaigns = await ctx.db.query("campaigns").order("desc").take(200);
                break;
            case "collect":
                campaigns = await ctx.db.query("campaigns").collect();
                break;
        }
        return {
            test: args.test,
            count: campaigns.length,
            totalJsonSize: JSON.stringify(campaigns).length,
        };
    },
});
