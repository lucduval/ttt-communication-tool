"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { OPPORTUNITY_TEMPERATURE } from "./actions/dynamics";
// Type-only (erased at build), so the node bundle stays free of the query module.
import type { ColdSweepMarkCold } from "./messages";

/**
 * Update the temperature of a Dynamics opportunity.
 * Hot (3) always wins — we never downgrade from Hot to Warm.
 */
export const updateTemperature = internalAction({
    args: {
        opportunityId: v.string(),
        temperature: v.number(),
    },
    handler: async (_ctx, args) => {
        const { dynamicsRequest } = await import("./lib/dynamics_auth");

        try {
            // Fetch current temperature to avoid downgrading
            const current = await dynamicsRequest<{ riivo_opportunitytemperature: number | null }>(
                `riivo_opportunities(${args.opportunityId})?$select=riivo_opportunitytemperature`
            );
            const currentTemp = current.riivo_opportunitytemperature ?? OPPORTUNITY_TEMPERATURE.PENDING;

            // Never downgrade: only update if the new temperature is higher
            if (args.temperature <= currentTemp) {
                return;
            }

            await dynamicsRequest(
                `riivo_opportunities(${args.opportunityId})`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        riivo_opportunitytemperature: args.temperature,
                        riivo_notyetcontacted: false,
                        riivo_contacted: true,
                    }),
                }
            );
        } catch (err) {
            console.error(`Failed to update opportunity temperature for ${args.opportunityId}:`, err);
        }
    },
});

/**
 * Mark unengaged opportunities as Cold (1).
 *
 * Drains a bounded page of the cold-sweep queue (messages with an opportunity,
 * sent more than 30 days ago, not yet evaluated), PATCHes the still-Pending ones
 * to Cold, then retires the page from the queue so the next run picks up fresh
 * work instead of re-reading the same head. Called by the daily cron.
 */
export const markStaleOpportunitiesCold = internalAction({
    args: {},
    handler: async (ctx) => {
        const { dynamicsRequest } = await import("./lib/dynamics_auth");
        const { internal } = await import("./_generated/api");

        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

        const verdicts = await ctx.runQuery(internal.messages.listUnengagedOpportunityMessages, {
            sentBefore: thirtyDaysAgo,
            limit: 200,
        });

        const unengaged = verdicts.filter((v): v is ColdSweepMarkCold => v.markCold);
        console.log(
            `[cold-cron] Evaluated ${verdicts.length} due messages; ${unengaged.length} unengaged`
        );

        // Rows we are done with. An engaged (or ineligible) row is retired
        // immediately; a Cold candidate only once its Dynamics write has actually
        // landed, so a transient CRM failure is retried on the next run rather
        // than silently dropped.
        const swept = verdicts.filter((v) => !v.markCold).map((v) => v.messageId);

        for (const { messageId, opportunityId } of unengaged) {
            try {
                // Only mark Cold if currently Pending — don't overwrite Warm/Hot
                const current = await dynamicsRequest<{ riivo_opportunitytemperature: number | null }>(
                    `riivo_opportunities(${opportunityId})?$select=riivo_opportunitytemperature`
                );
                const currentTemp = current.riivo_opportunitytemperature ?? OPPORTUNITY_TEMPERATURE.PENDING;

                if (currentTemp === OPPORTUNITY_TEMPERATURE.PENDING) {
                    await dynamicsRequest(
                        `riivo_opportunities(${opportunityId})`,
                        {
                            method: "PATCH",
                            body: JSON.stringify({
                                riivo_opportunitytemperature: OPPORTUNITY_TEMPERATURE.COLD,
                            }),
                        }
                    );
                }

                swept.push(messageId);
            } catch (err) {
                console.error(`Failed to mark opportunity ${opportunityId} as Cold:`, err);
            }
        }

        if (swept.length > 0) {
            await ctx.runMutation(internal.messages.markColdSweepSwept, { messageIds: swept });
        }
        console.log(`[cold-cron] Retired ${swept.length}/${verdicts.length} messages from the queue`);
    },
});
