

import { v } from "convex/values";
import { action, internalMutation, internalAction } from "./_generated/server";
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

                    // Strategy 1: Check attachments for original message headers (Graph API encapsulates original message)
                    if (message.hasAttachments) {
                        try {
                            const attUrl = `https://graph.microsoft.com/v1.0/users/${sharedMailbox}/messages/${message.id}/attachments?$expand=microsoft.graph.itemAttachment/item`;
                            const attRes = await fetch(attUrl, { headers: { Authorization: `Bearer ${token}` } });
                            if (attRes.ok) {
                                const attData = await attRes.json();
                                for (const att of attData.value) {
                                    if (att.item?.internetMessageHeaders) {
                                        for (const header of att.item.internetMessageHeaders) {
                                            if (header.name.toLowerCase() === 'x-campaign-id') {
                                                campaignId = header.value;
                                            }
                                            if (header.name.toLowerCase() === 'x-recipient-id') {
                                                recipientId = header.value;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.error(`Failed to fetch attachments for bounce from ${sharedMailbox} (${message.id}):`, e);
                        }
                    }

                    // Strategy 2: Check if the NDR body contains our custom headers as a fallback
                    if (!campaignId || !recipientId) {
                        const bodyContent = message.body.content;

                        // Strip HTML tags and decode common entities for reliable header extraction
                        // NDR bodies are HTML, so headers may be wrapped in tags or entity-encoded
                        const plainText = bodyContent
                            .replace(/<[^>]*>/g, " ")
                            .replace(/&nbsp;/gi, " ")
                            .replace(/&#160;/g, " ")
                            .replace(/&amp;/gi, "&")
                            .replace(/&lt;/gi, "<")
                            .replace(/&gt;/gi, ">");

                        const campaignMatch = plainText.match(/X-Campaign-ID:\s*([a-zA-Z0-9]+)/i);
                        const recipientMatch = plainText.match(/X-Recipient-ID:\s*([a-zA-Z0-9-_]+)/i);

                        if (!campaignId && campaignMatch && campaignMatch[1]) {
                            campaignId = campaignMatch[1];
                        }
                        if (!recipientId && recipientMatch && recipientMatch[1]) {
                            recipientId = recipientMatch[1];
                        }
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
                        // Mark as read to prevent re-processing every hour indefinitely.
                        // The log above preserves enough info for manual debugging.
                        await markMessageAsRead(token, sharedMailbox, message.id);
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
    try {
        const url = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}`;
        const response = await fetch(url, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ isRead: true }),
        });

        if (!response.ok) {
            console.error(`Failed to mark message ${messageId} as read in ${mailbox}: ${response.status}`);
        }
    } catch (error) {
        console.error(`Error marking message ${messageId} as read in ${mailbox}:`, error);
    }
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
        // Accumulate per-campaign stat deltas so we only fetch each campaign
        // document once, regardless of how many bounces belong to it.
        // Campaign docs can be very large (htmlBody, base64 attachments), so
        // reading the same one N times quickly exhausts the 16 MB bytes-read budget.
        type CampaignDelta = { failedDelta: number; deliveredDelta: number };
        const campaignDeltas = new Map<string, CampaignDelta>();

        for (const bounce of args.bounces) {
            const { campaignId: rawCampaignId, recipientId } = bounce;

            const campaignId = ctx.db.normalizeId("campaigns", rawCampaignId);
            if (!campaignId) {
                console.warn(`Invalid campaign ID in bounce: ${rawCampaignId}`);
                continue;
            }

            const message = await ctx.db
                .query("messages")
                .withIndex("by_campaign_recipient", (q) =>
                    q.eq("campaignId", campaignId).eq("recipientId", recipientId)
                )
                .first();

            if (message) {
                if (message.status !== "failed") {
                    await ctx.db.patch(message._id, {
                        status: "failed",
                        errorMessage: "Bounced (NDR received)",
                    });

                    const delta = campaignDeltas.get(campaignId) ?? { failedDelta: 0, deliveredDelta: 0 };
                    delta.failedDelta += 1;
                    if (message.status === "sent" || message.status === "delivered") {
                        delta.deliveredDelta -= 1;
                    }
                    campaignDeltas.set(campaignId, delta);
                }
            } else {
                console.warn(`Message not found for bounce: Campaign ${campaignId}, Recipient ${recipientId}`);
            }
        }

        // Apply stat changes — one campaign fetch per unique campaign.
        for (const [campaignId, delta] of campaignDeltas) {
            const id = ctx.db.normalizeId("campaigns", campaignId);
            if (!id) continue;
            const campaign = await ctx.db.get(id);
            if (campaign) {
                await ctx.db.patch(id, {
                    failedCount: (campaign.failedCount || 0) + delta.failedDelta,
                    ...(delta.deliveredDelta !== 0 && {
                        deliveredCount: Math.max(0, (campaign.deliveredCount || 0) + delta.deliveredDelta),
                    }),
                });
            }
        }
    },
});

/**
 * Debug action to fetch recent NDRs (including read ones) to inspect their structure
 * Useful for diagnosing why bounce tracking isn't finding headers
 */
export const debugBounces = action({
    args: {
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const token = await getGraphAccessToken();
        const sharedMailboxesEnv = process.env.SHARED_MAILBOX_ADDRESS;

        if (!sharedMailboxesEnv) return { error: "SHARED_MAILBOX_ADDRESS is not configured" };

        const sharedMailboxes = sharedMailboxesEnv.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (sharedMailboxes.length === 0) return { error: "SHARED_MAILBOX_ADDRESS is empty" };

        const filter = "contains(subject, 'Undeliverable') or contains(subject, 'Delivery Status Notification')";
        const top = args.limit || 5;
        const results: any[] = [];

        for (const sharedMailbox of sharedMailboxes) {
            try {
                // Fetch messages
                const url = `https://graph.microsoft.com/v1.0/users/${sharedMailbox}/messages?$filter=${encodeURIComponent(filter)}&$top=${top}&$select=id,subject,body,internetMessageHeaders,receivedDateTime,hasAttachments`;

                const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (!response.ok) {
                    results.push({ mailbox: sharedMailbox, error: await response.text() });
                    continue;
                }

                const data = await response.json();
                const messages = data.value;

                for (const message of messages) {
                    let campaignId: string | null = null;
                    let recipientId: string | null = null;
                    let attachments = null;
                    if (message.hasAttachments) {
                        try {
                            const attUrl = `https://graph.microsoft.com/v1.0/users/${sharedMailbox}/messages/${message.id}/attachments?$expand=microsoft.graph.itemAttachment/item`;
                            const attRes = await fetch(attUrl, { headers: { Authorization: `Bearer ${token}` } });
                            if (attRes.ok) {
                                const attData = await attRes.json();
                                // Extract custom headers if any
                                attachments = attData.value.map((a: any) => ({
                                    name: a.name,
                                    contentType: a.contentType,
                                    itemHeaders: a.item?.internetMessageHeaders
                                }));

                                for (const att of attData.value) {
                                    if (att.item?.internetMessageHeaders) {
                                        for (const header of att.item.internetMessageHeaders) {
                                            if (header.name.toLowerCase() === 'x-campaign-id') {
                                                campaignId = header.value;
                                            }
                                            if (header.name.toLowerCase() === 'x-recipient-id') {
                                                recipientId = header.value;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            attachments = { error: String(e) };
                        }
                    }

                    if (!campaignId || !recipientId) {
                        const bodyContent = message.body?.content || "";
                        const plainText = bodyContent
                            .replace(/<[^>]*>/g, " ")
                            .replace(/&nbsp;/gi, " ")
                            .replace(/&#160;/g, " ")
                            .replace(/&amp;/gi, "&")
                            .replace(/&lt;/gi, "<")
                            .replace(/&gt;/gi, ">");

                        const campaignMatch = plainText.match(/X-Campaign-ID:\s*([a-zA-Z0-9]+)/i);
                        const recipientMatch = plainText.match(/X-Recipient-ID:\s*([a-zA-Z0-9-_]+)/i);

                        if (!campaignId && campaignMatch && campaignMatch[1]) {
                            campaignId = campaignMatch[1];
                        }
                        if (!recipientId && recipientMatch && recipientMatch[1]) {
                            recipientId = recipientMatch[1];
                        }
                    }

                    results.push({
                        mailbox: sharedMailbox,
                        id: message.id,
                        subject: message.subject,
                        receivedDateTime: message.receivedDateTime,
                        hasAttachments: message.hasAttachments,
                        campaignId,
                        recipientId,
                        // fullBody: message.body?.content, // Excluded to keep output small
                        attachments
                    });
                }
            } catch (error) {
                results.push({ mailbox: sharedMailbox, error: String(error) });
            }
        }

        return results;
    },
});
