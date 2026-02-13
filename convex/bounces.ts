

import { v } from "convex/values";
import { internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getGraphAccessToken } from "./lib/graph_client";

/**
 * Process bounced emails (NDRs) from the shared mailbox.
 * Looks for emails with "Undeliverable" or "Delivery Status Notification" in the subject.
 * Parses the original message headers to find X-Campaign-ID and X-Recipient-ID.
 */
export const processBounces = internalAction({
    args: {
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const token = await getGraphAccessToken();
        const sharedMailboxesEnv = process.env.SHARED_MAILBOX_ADDRESS;

        if (!sharedMailboxesEnv) {
            throw new Error("SHARED_MAILBOX_ADDRESS is not configured");
        }

        const sharedMailboxes = sharedMailboxesEnv.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

        if (sharedMailboxes.length === 0) {
            throw new Error("SHARED_MAILBOX_ADDRESS is configured but empty");
        }

        let totalProcessedCount = 0;
        let totalFoundCount = 0;
        const allBouncedRecipients: Array<{ campaignId: string; recipientId: string; messageId: string; mailbox: string }> = [];

        // Fetch unread messages that look like bounces
        // We filter by subject contains 'Undeliverable' or 'Delivery Status Notification'
        // Graph API filter: isRead eq false and (contains(subject, 'Undeliverable') or contains(subject, 'Delivery Status Notification'))
        const filter = "isRead eq false and (contains(subject, 'Undeliverable') or contains(subject, 'Delivery Status Notification'))";
        const top = args.limit || 50;

        for (const sharedMailbox of sharedMailboxes) {
            try {
                // Let's start by fetching the messages and their bodies.
                const url = `https://graph.microsoft.com/v1.0/users/${sharedMailbox}/messages?$filter=${encodeURIComponent(filter)}&$top=${top}&$select=id,subject,body,internetMessageHeaders,receivedDateTime`;

                const response = await fetch(url, {
                    headers: { Authorization: `Bearer ${token}` },
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Failed to fetch messages for ${sharedMailbox}: ${response.status} - ${errorText}`);
                    continue; // Skip this mailbox and try the next one
                }

                const data = await response.json();
                const messages = data.value;
                totalFoundCount += messages.length;

                for (const message of messages) {
                    let campaignId: string | null = null;
                    let recipientId: string | null = null;

                    // Strategy 1: Check if the NDR body contains our custom headers
                    // Outlook often puts the original headers in the body of the bounce message
                    const bodyContent = message.body.content;

                    // Regex to find X-Campaign-ID: ... and X-Recipient-ID: ...
                    // These might be HTML encoded or plain text, so be careful.
                    // Simple regex for likely plain text representation in the body dump
                    const campaignMatch = bodyContent.match(/X-Campaign-ID:\s*([a-zA-Z0-9]+)/i);
                    const recipientMatch = bodyContent.match(/X-Recipient-ID:\s*([a-zA-Z0-9-_]+)/i);

                    if (campaignMatch && campaignMatch[1]) {
                        campaignId = campaignMatch[1];
                    }
                    if (recipientMatch && recipientMatch[1]) {
                        recipientId = recipientMatch[1];
                    }

                    if (campaignId && recipientId) {
                        allBouncedRecipients.push({
                            campaignId,
                            recipientId,
                            messageId: message.id,
                            mailbox: sharedMailbox,
                        });
                        totalProcessedCount++;
                    } else {
                        console.log(`Could not find tracking headers in bounce message from ${sharedMailbox}: ${message.subject} (${message.id})`);
                        // Optional: Mark as read anyway so we don't process it forever? 
                        // For now, leave it unread so we can manually inspect if needed.
                    }
                }
            } catch (error) {
                console.error(`Error processing bounces for mailbox ${sharedMailbox}:`, error);
            }
        }

        if (allBouncedRecipients.length > 0) {
            // We only send the necessary fields to the mutation
            const bouncesForMutation = allBouncedRecipients.map(({ campaignId, recipientId, messageId }) => ({
                campaignId,
                recipientId,
                messageId
            }));

            await ctx.runMutation(internal.bounces.recordBounces, {
                bounces: bouncesForMutation,
            });

            // Mark processed messages as read
            // We need to use the correct mailbox for each message
            for (const bounce of allBouncedRecipients) {
                await markMessageAsRead(token, bounce.mailbox, bounce.messageId);
            }
        }

        return {
            processed: totalProcessedCount,
            found: totalFoundCount,
        };
    },
});

async function markMessageAsRead(token: string, mailbox: string, messageId: string) {
    const url = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}`;
    await fetch(url, {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ isRead: true }),
    });
}

export const recordBounces = internalMutation({
    args: {
        bounces: v.array(v.object({
            campaignId: v.string(),
            recipientId: v.string(),
            messageId: v.string(),
        })),
    },
    handler: async (ctx, args) => {
        for (const bounce of args.bounces) {
            const { campaignId: rawCampaignId, recipientId } = bounce;

            // Validate campaign ID
            const campaignId = ctx.db.normalizeId("campaigns", rawCampaignId);
            if (!campaignId) {
                console.warn(`Invalid campaign ID in bounce: ${rawCampaignId}`);
                continue;
            }

            // Find the message record
            const message = await ctx.db
                .query("messages")
                .withIndex("by_campaign_recipient", (q) =>
                    q.eq("campaignId", campaignId).eq("recipientId", recipientId)
                )
                .first();

            if (message) {
                // Update message status to failed
                if (message.status !== "failed") {
                    await ctx.db.patch(message._id, {
                        status: "failed",
                        errorMessage: "Bounced (NDR received)",
                    });

                    // Update campaign stats
                    const campaign = await ctx.db.get(campaignId);
                    if (campaign) {
                        // We need to be careful not to double count if we run this multiple times
                        // But we check message.status !== "failed" above, so it should be fine.
                        // Also, if it was 'sent' or 'delivered' before, we might want to decrement those counts?
                        // For simplicity, just increment failedCount.
                        // Ideally we should decrement 'deliveredCount' if it was counted as delivered (which it shouldn't be for email usually, unless we track fake delivery)

                        await ctx.db.patch(campaignId, {
                            failedCount: (campaign.failedCount || 0) + 1,
                            // precise accounting might require checking previous status
                        });
                    }
                }
            } else {
                console.warn(`Message not found for bounce: Campaign ${campaignId}, Recipient ${recipientId}`);
            }
        }
    },
});
