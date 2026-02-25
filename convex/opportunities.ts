"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const OPPORTUNITY_TEMPERATURE = { PENDING: 0, COLD: 1, WARM: 2, HOT: 3 } as const;

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
 * Mark all unengaged opportunities as Cold (1).
 * Called by the daily cron job for messages older than 30 days with no opens or clicks.
 */
export const markStaleOpportunitiesCold = internalAction({
    args: {},
    handler: async (ctx) => {
        const { dynamicsRequest } = await import("./lib/dynamics_auth");
        const { internal } = await import("./_generated/api");

        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

        const unengaged = await ctx.runQuery(internal.messages.listUnengagedOpportunityMessages, {
            sentBefore: thirtyDaysAgo,
            limit: 100,
        });

        console.log(`[cold-cron] Found ${unengaged.length} unengaged opportunities to mark Cold`);

        for (const { opportunityId } of unengaged) {
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
            } catch (err) {
                console.error(`Failed to mark opportunity ${opportunityId} as Cold:`, err);
            }
        }
    },
});
