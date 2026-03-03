import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const backfillAllMessages = internalMutation({
    args: {},
    handler: async (ctx) => {
        const campaigns = await ctx.db.query("campaigns").collect();
        let totalCreated = 0;

        for (const campaign of campaigns) {
            const batches = await ctx.db
                .query("campaignBatches")
                .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
                .collect();

            if (batches.length === 0) continue;

            for (const batch of batches) {
                if (!batch.recipients) continue;

                for (const recipient of batch.recipients as any[]) {
                    // Check if message already exists
                    const existingMessage = await ctx.db
                        .query("messages")
                        .withIndex("by_campaign_recipient", (q) =>
                            q.eq("campaignId", campaign._id).eq("recipientId", recipient.id)
                        )
                        .first();

                    if (!existingMessage) {
                        await ctx.db.insert("messages", {
                            campaignId: campaign._id,
                            recipientId: recipient.id,
                            recipientEmail: recipient.email,
                            recipientPhone: recipient.phone,
                            recipientName: recipient.name,
                            // If batch completed, mark 'sent', else 'pending'
                            status: batch.status === "completed" ? "sent" : "pending",
                            channel: campaign.channel,
                            sentAt: batch.completedAt || campaign._creationTime,
                        });
                        totalCreated++;
                    }
                }
            }
        }

        return { totalCreated };
    },
});
