import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { checkAccessHelper } from "./users";

/**
 * Insert history records for a batch of successfully-sent personalised emails.
 * Skips any (contactId, campaignName) pair that already exists — idempotent.
 */
export const recordSentBatch = internalMutation({
    args: {
        records: v.array(v.object({
            contactId: v.string(),
            campaignId: v.id("campaigns"),
            campaignName: v.string(),
            sentAt: v.number(),
        })),
    },
    handler: async (ctx, args) => {
        for (const record of args.records) {
            const existing = await ctx.db
                .query("personalisedCampaignHistory")
                .withIndex("by_contact_campaign_name", (q) =>
                    q.eq("contactId", record.contactId).eq("campaignName", record.campaignName)
                )
                .first();

            if (!existing) {
                await ctx.db.insert("personalisedCampaignHistory", {
                    contactId: record.contactId,
                    campaignId: record.campaignId,
                    campaignName: record.campaignName,
                    sentAt: record.sentAt,
                });
            }
        }
    },
});

/**
 * Returns the contactIds that have already been sent a given campaign name.
 * Returns a plain string[] (Convex-serializable); callers build a Set locally.
 */
export const getContactIdsForCampaignName = internalQuery({
    args: { campaignName: v.string() },
    handler: async (ctx, args): Promise<string[]> => {
        const rows = await ctx.db
            .query("personalisedCampaignHistory")
            .withIndex("by_campaign_name", (q) => q.eq("campaignName", args.campaignName))
            .collect();

        return rows.map((r) => r.contactId);
    },
});

/**
 * Given a list of contact IDs, returns a map of contactId -> campaign history entries.
 * Used by the recipients UI to display personalised campaign badges per contact.
 */
export const getHistoryByContactIds = query({
    args: { contactIds: v.array(v.string()) },
    handler: async (ctx, args): Promise<Record<string, { campaignName: string; sentAt: number }[]>> => {
        if (args.contactIds.length === 0) return {};

        const results = await Promise.all(
            args.contactIds.map((contactId) =>
                ctx.db
                    .query("personalisedCampaignHistory")
                    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
                    .collect()
            )
        );

        const map: Record<string, { campaignName: string; sentAt: number }[]> = {};
        for (let i = 0; i < args.contactIds.length; i++) {
            const entries = results[i];
            if (entries.length > 0) {
                map[args.contactIds[i]] = entries.map((e) => ({
                    campaignName: e.campaignName,
                    sentAt: e.sentAt,
                }));
            }
        }
        return map;
    },
});

/**
 * Admin-only backfill: scans all existing personalised messages that were
 * successfully sent and creates history records for any that are missing.
 * Safe to run multiple times — existing records are skipped.
 */
export const backfillFromExistingMessages = mutation({
    args: {},
    handler: async (ctx): Promise<{ created: number; skipped: number }> => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess || access.user?.role !== "admin") {
            throw new Error("Unauthorized");
        }

        // Collect all sent + delivered personalised messages
        const [sentMessages, deliveredMessages] = await Promise.all([
            ctx.db
                .query("messages")
                .withIndex("by_status", (q) => q.eq("status", "sent"))
                .collect(),
            ctx.db
                .query("messages")
                .withIndex("by_status", (q) => q.eq("status", "delivered"))
                .collect(),
        ]);

        const personalisedMessages = [...sentMessages, ...deliveredMessages].filter(
            (m) => m.channel === "personalised"
        );

        if (personalisedMessages.length === 0) {
            return { created: 0, skipped: 0 };
        }

        // Cache campaign names to avoid repeated lookups
        const campaignNameCache = new Map<string, string>();
        const getCampaignName = async (campaignId: string): Promise<string | null> => {
            if (campaignNameCache.has(campaignId)) return campaignNameCache.get(campaignId)!;
            const campaign = await ctx.db.get(campaignId as any);
            const name = (campaign as any)?.name ?? null;
            if (name) campaignNameCache.set(campaignId, name);
            return name;
        };

        let created = 0;
        let skipped = 0;

        for (const msg of personalisedMessages) {
            const campaignName = await getCampaignName(msg.campaignId as string);
            if (!campaignName) {
                skipped++;
                continue;
            }

            const existing = await ctx.db
                .query("personalisedCampaignHistory")
                .withIndex("by_contact_campaign_name", (q) =>
                    q.eq("contactId", msg.recipientId).eq("campaignName", campaignName)
                )
                .first();

            if (existing) {
                skipped++;
            } else {
                await ctx.db.insert("personalisedCampaignHistory", {
                    contactId: msg.recipientId,
                    campaignId: msg.campaignId,
                    campaignName,
                    sentAt: msg.sentAt ?? msg._creationTime,
                });
                created++;
            }
        }

        return { created, skipped };
    },
});
