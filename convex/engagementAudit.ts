import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
    assessEngagement,
    DEFAULT_TRUST_POLICY,
    type EngagementEvidence,
    type TrustPolicy,
} from "./lib/engagementTrust";

export interface ClickAuthenticityReport {
    policy: TrustPolicy;
    campaignsAudited: number;
    clickerRecipients: number;
    openerRecipients: number;
    trustedHot: number;
    suspectClickers: number;
    suspectSharePct: number;
    suspectBreakdown: { clickWithNoOpen: number; clickWithinPrefetchWindow: number };
    clickLatencyBuckets: {
        under2m: number;
        "2m_10m": number;
        "10m_1h": number;
        over1h: number;
        unknown: number;
    };
    topSuspectUserAgents: Array<{ userAgent: string; count: number }>;
    samples: Array<{
        campaignId: string;
        recipientId: string;
        hasOpen: boolean;
        clickLatencyMs?: number;
        reasons: string[];
        userAgent?: string;
    }>;
}

/**
 * Diagnostic: how many of our "clicked → HOT" labels are actually mail-gateway
 * prefetches rather than humans?
 *
 * Run from the Convex dashboard (Functions → engagementAudit:auditClickAuthenticity).
 * Optionally pass a `campaignId` to audit one campaign; otherwise it scans the
 * most recent `maxCampaigns` email campaigns (default 20).
 *
 * It reuses the pure Engagement Trust rule (`assessEngagement`) — so the numbers
 * it reports are exactly what the intake rule would decide if adopted. Read-only.
 */
export const auditClickAuthenticity = action({
    args: {
        campaignId: v.optional(v.id("campaigns")),
        maxCampaigns: v.optional(v.number()),
    },
    handler: async (ctx, args): Promise<ClickAuthenticityReport> => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        return await ctx.runQuery(internal.engagementAudit.computeClickAuthenticity, args);
    },
});

const SAMPLE_CAP = 25;

export const computeClickAuthenticity = internalQuery({
    args: {
        campaignId: v.optional(v.id("campaigns")),
        maxCampaigns: v.optional(v.number()),
    },
    handler: async (ctx, args): Promise<ClickAuthenticityReport> => {
        // 1. Resolve which campaigns to audit.
        let campaignIds: Id<"campaigns">[];
        if (args.campaignId) {
            campaignIds = [args.campaignId];
        } else {
            const recent = await ctx.db
                .query("campaigns")
                .filter((q) => q.eq(q.field("channel"), "email"))
                .order("desc")
                .take(args.maxCampaigns ?? 20);
            campaignIds = recent.map((c) => c._id);
        }

        // Aggregates.
        let clickerRecipients = 0; // distinct recipients with >=1 click (today's HOT population)
        let openerRecipients = 0;
        let trustedHot = 0; // would remain HOT under the trust rule
        let suspectClickers = 0; // clicked, but the evidence says scanner
        let suspectNoOpen = 0;
        let suspectPrefetch = 0;

        // Click latency distribution (earliest click − sentAt).
        const latencyBuckets = { under2m: 0, "2m_10m": 0, "10m_1h": 0, over1h: 0, unknown: 0 };
        const suspectUserAgents = new Map<string, number>();
        const samples: Array<{
            campaignId: string;
            recipientId: string;
            hasOpen: boolean;
            clickLatencyMs?: number;
            reasons: string[];
            userAgent?: string;
        }> = [];

        for (const campaignId of campaignIds) {
            // sentAt per recipient.
            const messages = await ctx.db
                .query("messages")
                .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
                .collect();
            const sentAt = new Map<string, number | undefined>();
            for (const m of messages) sentAt.set(m.recipientId, m.sentAt);

            // earliest open per recipient.
            const opens = await ctx.db
                .query("opens")
                .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
                .collect();
            const firstOpen = new Map<string, number>();
            for (const o of opens) {
                const prev = firstOpen.get(o.recipientId);
                if (prev === undefined || o.openedAt < prev) firstOpen.set(o.recipientId, o.openedAt);
            }
            openerRecipients += firstOpen.size;

            // earliest click + a representative user-agent per recipient.
            const clicks = await ctx.db
                .query("clicks")
                .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
                .collect();
            const firstClick = new Map<string, number>();
            const clickUserAgent = new Map<string, string | undefined>();
            for (const c of clicks) {
                const prev = firstClick.get(c.recipientId);
                if (prev === undefined || c.clickedAt < prev) {
                    firstClick.set(c.recipientId, c.clickedAt);
                    clickUserAgent.set(c.recipientId, c.userAgent);
                }
            }

            // Assess every recipient who clicked — the current HOT population.
            for (const [recipientId, clickedAt] of firstClick) {
                clickerRecipients++;

                const sent = sentAt.get(recipientId);
                const openedAt = firstOpen.get(recipientId);
                const clickLatencyMs = sent !== undefined ? clickedAt - sent : undefined;
                const openLatencyMs =
                    sent !== undefined && openedAt !== undefined ? openedAt - sent : undefined;

                // latency distribution.
                if (clickLatencyMs === undefined) latencyBuckets.unknown++;
                else if (clickLatencyMs < 2 * 60_000) latencyBuckets.under2m++;
                else if (clickLatencyMs < 10 * 60_000) latencyBuckets["2m_10m"]++;
                else if (clickLatencyMs < 60 * 60_000) latencyBuckets["10m_1h"]++;
                else latencyBuckets.over1h++;

                const evidence: EngagementEvidence = {
                    hasOpen: openedAt !== undefined,
                    hasClick: true,
                    clickLatencyMs,
                    openLatencyMs,
                };
                const result = assessEngagement(evidence, DEFAULT_TRUST_POLICY);

                if (result.verdict === "hot") {
                    trustedHot++;
                } else if (result.suspectClick) {
                    suspectClickers++;
                    if (openedAt === undefined) suspectNoOpen++;
                    if (clickLatencyMs !== undefined && clickLatencyMs < DEFAULT_TRUST_POLICY.prefetchWindowMs) {
                        suspectPrefetch++;
                    }
                    const ua = clickUserAgent.get(recipientId) ?? "(none)";
                    suspectUserAgents.set(ua, (suspectUserAgents.get(ua) ?? 0) + 1);
                    if (samples.length < SAMPLE_CAP) {
                        samples.push({
                            campaignId,
                            recipientId,
                            hasOpen: openedAt !== undefined,
                            clickLatencyMs,
                            reasons: result.reasons,
                            userAgent: clickUserAgent.get(recipientId),
                        });
                    }
                }
            }
        }

        const topSuspectUserAgents = [...suspectUserAgents.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([userAgent, count]) => ({ userAgent, count }));

        return {
            policy: DEFAULT_TRUST_POLICY,
            campaignsAudited: campaignIds.length,
            clickerRecipients, // what we label HOT today
            openerRecipients,
            trustedHot, // what would stay HOT under corroboration
            suspectClickers, // HOT labels the evidence cannot support
            suspectSharePct:
                clickerRecipients > 0 ? Math.round((suspectClickers / clickerRecipients) * 1000) / 10 : 0,
            suspectBreakdown: {
                clickWithNoOpen: suspectNoOpen,
                clickWithinPrefetchWindow: suspectPrefetch,
            },
            clickLatencyBuckets: latencyBuckets,
            topSuspectUserAgents,
            samples,
        };
    },
});
