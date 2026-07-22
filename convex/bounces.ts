

import { v } from "convex/values";
import { action, internalMutation, internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getGraphAccessToken, parseRetryAfter } from "./lib/graph_client";
import { recomputeCampaignStats } from "./campaignBatches";

/**
 * Marking bounce NDRs as read is a per-message Graph PATCH. Firing them back to
 * back with no backoff is what tripped Graph's mailbox throttle (HTTP 429) — the
 * "Failed to mark message … as read: 429" flood. `MARK_READ_PACING_MS` spaces the
 * sequential marks so we stay under the throttle in the first place; the
 * per-request retry below then absorbs any 429 that still slips through by
 * honouring the server's `Retry-After`. The honoured wait is capped so a single
 * message can never stall the whole action past Convex's ~10-min limit.
 */
const MARK_READ_PACING_MS = 100;
const MARK_READ_MAX_ATTEMPTS = 5;
const MARK_READ_BACKOFF_BASE_MS = 500;
const MARK_READ_MAX_RETRY_AFTER_MS = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

            // Mark processed messages as read, pacing the marks so we don't trip
            // Graph's mailbox throttle. We need the correct mailbox for each message.
            for (let i = 0; i < allBouncedRecipients.length; i++) {
                const bounce = allBouncedRecipients[i];
                await markMessageAsRead(token, bounce.mailbox, bounce.messageId);
                if (i + 1 < allBouncedRecipients.length) {
                    await defaultSleep(MARK_READ_PACING_MS);
                }
            }
        }

        return {
            processed: totalProcessedCount,
            found: totalFoundCount,
        };
    },
});

/**
 * Mark one bounce NDR as read, retrying on Graph throttling (429) and transient
 * 5xx with exponential backoff that honours the server's `Retry-After`. Never
 * throws — a message that still can't be marked after the retry budget is logged
 * and skipped (it will simply be re-seen next run), so it can't abort the action.
 * `sleep` is injectable so tests exercise the backoff without real wall-clock.
 */
export async function markMessageAsRead(
    token: string,
    mailbox: string,
    messageId: string,
    sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<boolean> {
    const url = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}`;

    for (let attempt = 1; attempt <= MARK_READ_MAX_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(url, {
                method: "PATCH",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ isRead: true }),
            });

            if (response.ok) return true;

            const retryable = response.status === 429 || response.status >= 500;
            if (retryable && attempt < MARK_READ_MAX_ATTEMPTS) {
                const retryAfterSec = parseRetryAfter(response.headers.get("Retry-After"));
                const backoffMs =
                    retryAfterSec != null
                        ? Math.min(retryAfterSec * 1000, MARK_READ_MAX_RETRY_AFTER_MS)
                        : MARK_READ_BACKOFF_BASE_MS * 2 ** (attempt - 1);
                await sleep(backoffMs);
                continue;
            }

            console.error(
                `Failed to mark message ${messageId} as read in ${mailbox}: ${response.status}`
            );
            return false;
        } catch (error) {
            if (attempt < MARK_READ_MAX_ATTEMPTS) {
                await sleep(MARK_READ_BACKOFF_BASE_MS * 2 ** (attempt - 1));
                continue;
            }
            console.error(`Error marking message ${messageId} as read in ${mailbox}:`, error);
            return false;
        }
    }
    return false;
}

/**
 * Plain implementation of bounce recording, with the Convex `ctx` injected so
 * the recompute-funnel behaviour is unit-testable (mirrors `recoverStuckBatchesImpl`).
 *
 * Each bounce flips its recipient's message to "failed" (the source of truth);
 * then the stat cache for every affected campaign is recomputed exactly once,
 * AFTER all per-message patches land. The recompute reads the messages table —
 * so a delivered→failed flip lowers `delivered` and raises `failed` for free,
 * with no additive delta arithmetic that could drift. Recomputing once per
 * unique campaign keeps the (potentially multi-MB) campaign doc out of the inner
 * loop, preserving the old per-campaign read-budget guarantee.
 */
export async function recordBouncesImpl(
    ctx: { db: any },
    bounces: Array<{ campaignId: string; recipientId: string; messageId: string }>
): Promise<void> {
    const affectedCampaigns = new Set<Id<"campaigns">>();

    for (const bounce of bounces) {
        const { campaignId: rawCampaignId, recipientId } = bounce;

        const campaignId = ctx.db.normalizeId("campaigns", rawCampaignId);
        if (!campaignId) {
            console.warn(`Invalid campaign ID in bounce: ${rawCampaignId}`);
            continue;
        }

        const message = await ctx.db
            .query("messages")
            .withIndex("by_campaign_recipient", (q: any) =>
                q.eq("campaignId", campaignId).eq("recipientId", recipientId)
            )
            .first();

        if (!message) {
            console.warn(`Message not found for bounce: Campaign ${campaignId}, Recipient ${recipientId}`);
            continue;
        }

        // Idempotent: an already-failed message needs no re-patch and no recompute.
        if (message.status !== "failed") {
            await ctx.db.patch(message._id, {
                status: "failed",
                errorMessage: "Bounced (NDR received)",
            });
            affectedCampaigns.add(campaignId);
        }
    }

    // One recompute per affected campaign, after every per-message patch has landed.
    for (const campaignId of affectedCampaigns) {
        await recomputeCampaignStats(ctx, campaignId);
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
    handler: async (ctx, args) => recordBouncesImpl(ctx, args.bounces),
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
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
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
