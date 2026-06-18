"use node";

import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { ChannelSender, DriverBatch, EmitFn } from "./lib/channelSend";

/**
 * Channel Senders — the per-channel adapters behind the Channel Send seam. Each
 * owns only its channel's per-recipient send loop and side-effects, streaming
 * results to the driver via `emit`. The batch lifecycle lives entirely in the
 * driver (convex/lib/channelSend.ts).
 *
 * Email is migrated here first (PRD #8, issue #13); WhatsApp and personalised
 * follow in #14/#15.
 */

// Email backs off further than other channels after a thrown error to let Graph
// recover; on the success path the successor delay is GRAPH_BATCH_DELAY_MS.
const emailBatchDelayMs = () => parseInt(process.env.GRAPH_BATCH_DELAY_MS ?? "500", 10) || 500;

/**
 * Generate an HTML unsubscribe footer for marketing email compliance.
 */
function getUnsubscribeFooter(unsubscribeUrl: string): string {
    return `
    <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #718096; font-family: Arial, Helvetica, sans-serif;">
        <p style="margin: 4px 0;">You are receiving this email because you are a client of TTT.</p>
        <p style="margin: 4px 0;">
            If you no longer wish to receive these emails, you can
            <a href="${unsubscribeUrl}" style="color: #1a73e8; text-decoration: underline;">unsubscribe here</a>.
        </p>
    </div>`;
}

/**
 * Email Channel Sender. Owns Graph `$batch` chunking, the validate/prepare phase,
 * the already-sent dedup, opportunity creation, and the deferred CRM-logging queue.
 * Per-recipient results are streamed to the driver via `emit`; flushing is the
 * driver's. Returns `nextDelayMs` for the successor batch.
 */
async function sendEmailBatch_(
    ctx: ActionCtx,
    campaign: any,
    batch: DriverBatch,
    emit: EmitFn
): Promise<{ halt?: string; nextDelayMs?: number }> {
    const campaignId = campaign._id as Id<"campaigns">;

    const campaignContent = await ctx.runQuery(internal.campaignBatches.getCampaignContent, {
        campaignId,
    });

    // Recipients already flushed as sent for this batch are skipped, making batch
    // processing idempotent across a crash/timeout-driven recovery.
    const alreadySentArr = await ctx.runQuery(internal.messages.getSentRecipientIds, {
        campaignId,
        recipientIds: batch.recipients.map((r) => r.id),
    });
    const alreadySent = new Set(alreadySentArr);

    const crmQueue: Array<{ recipientId: string; subject: string; body: string }> = [];

    const { sendEmailBatch } = await import("./lib/graph_client");
    const { wrapEmail } = await import("./lib/emailLayout");
    const { rewriteEmailLinks } = await import("./lib/tracking_utils");

    // Resolve attachments once per batch (not once per recipient) — fetching from
    // Convex storage per recipient was the primary cause of slow campaigns.
    const processedAttachments: Array<{
        name: string;
        contentType: string;
        contentBase64: string;
        isInline?: boolean;
        contentId?: string;
    }> = [];
    if (campaignContent?.attachments) {
        for (const att of campaignContent.attachments) {
            let contentBase64 = att.contentBase64;

            if (att.storageId && !contentBase64) {
                try {
                    const fileUrl = await ctx.runQuery(internal.files.getDownloadUrlInternal, {
                        storageId: att.storageId,
                    });
                    if (fileUrl) {
                        const response = await fetch(fileUrl);
                        const arrayBuffer = await response.arrayBuffer();
                        contentBase64 = Buffer.from(arrayBuffer).toString("base64");
                    }
                } catch (e) {
                    console.error(`Failed to fetch attachment ${att.name} from storage:`, e);
                }
            }

            const base64 = contentBase64 ?? att.contentBase64;
            if (base64) {
                processedAttachments.push({
                    name: att.name,
                    contentType: att.contentType,
                    contentBase64: base64,
                    isInline: att.isInline,
                    contentId: (att as any).contentId,
                });
            }
        }
    }

    // Phase 1: validate + render every recipient that hasn't already been sent.
    // Invalid recipients are recorded as failures up-front so they never reach
    // the $batch call.
    const siteUrl = process.env.CONVEX_SITE_URL || "";
    type PreparedSend = {
        recipient: { id: string; email?: string; name: string };
        message: Parameters<typeof sendEmailBatch>[0][number];
    };
    const prepared: PreparedSend[] = [];

    for (const recipient of batch.recipients) {
        if (alreadySent.has(recipient.id)) continue;

        // Strip whitespace and Unicode space characters (e.g. \u00a0 from Dynamics CRM)
        // that pass a truthiness check but are rejected by the Graph API.
        const cleanEmail = recipient.email?.replace(/[\u00a0\u200B-\u200D\uFEFF\s]/g, "");

        // Lead email fields in Dynamics sometimes hold multiple comma-separated
        // addresses; Graph rejects the whole string as one recipient. Split into
        // individual addresses so they go on the TO line as separate recipients.
        const emailAddresses = (cleanEmail ?? "")
            .split(",")
            .map((e) => e.trim())
            .filter((e) => e.length > 0 && e.includes("@"));

        if (emailAddresses.length === 0) {
            await emit([
                {
                    recipientId: recipient.id,
                    success: false,
                    error: `Invalid email address: "${recipient.email}"`,
                },
            ]);
            continue;
        }

        try {
            const recipientFirstName = recipient.name?.split(" ")[0] || recipient.name || "";
            const recipientFullName = recipient.name || "";
            const recipientEmail = emailAddresses[0];

            const applyMergeFields = (text: string) =>
                text
                    .replace(/\{firstName\}/g, recipientFirstName)
                    .replace(/\{fullName\}/g, recipientFullName)
                    .replace(/\{email\}/g, recipientEmail);

            const unsubscribeUrl = siteUrl ? `${siteUrl}/unsubscribe?id=${recipient.id}` : "";

            const mergedHtmlBody = applyMergeFields(campaignContent?.htmlBody || "");

            let emailBody = wrapEmail(
                mergedHtmlBody + (unsubscribeUrl ? getUnsubscribeFooter(unsubscribeUrl) : ""),
                campaign.subject || "Notification",
                campaignContent?.fontSize || "15px"
            );

            if (siteUrl) {
                emailBody = (await rewriteEmailLinks(emailBody, siteUrl, campaignId, recipient.id)) as string;
            }

            const mergedSubject = applyMergeFields(campaign.subject || "");

            prepared.push({
                recipient,
                message: {
                    subject: mergedSubject,
                    body: emailBody,
                    toRecipients: emailAddresses.map((email) => ({ email, name: recipient.name })),
                    ccRecipients: campaign.ccEmail ? [{ email: campaign.ccEmail }] : undefined,
                    bccRecipients: campaign.bccEmail ? [{ email: campaign.bccEmail }] : undefined,
                    attachments: processedAttachments,
                    fromMailbox: campaign.fromMailbox,
                    headers: {
                        "X-Campaign-ID": campaignId,
                        "X-Recipient-ID": recipient.id,
                    },
                },
            });
        } catch (err) {
            await emit([
                {
                    recipientId: recipient.id,
                    success: false,
                    error: err instanceof Error ? err.message : "Unknown error during render",
                },
            ]);
        }
    }

    // Phase 2: send in chunks of 20 via Microsoft Graph $batch. Graph caps $batch
    // at 20 sub-requests per call; per-item 429/5xx retries are handled inside
    // sendEmailBatch.
    const SUB_BATCH = 20;
    const interBatchDelayMs = Math.max(
        0,
        parseInt(process.env.GRAPH_EMAIL_INTER_BATCH_DELAY_MS ?? "200", 10) || 0
    );

    for (let i = 0; i < prepared.length; i += SUB_BATCH) {
        const slice = prepared.slice(i, i + SUB_BATCH);
        const sendResults = await sendEmailBatch(slice.map((p) => p.message));

        for (let j = 0; j < slice.length; j++) {
            const { recipient } = slice[j];
            const r = sendResults[j];

            if (r.success) {
                await emit([{ recipientId: recipient.id, success: true }]);

                if (campaign.createDynamicsActivity) {
                    crmQueue.push({
                        recipientId: recipient.id,
                        subject: campaign.subject || "",
                        body: campaignContent?.htmlBody || "",
                    });
                }

                if (campaign.createOpportunities) {
                    try {
                        const opportunityId = await ctx.runAction(
                            internal.actions.dynamics.createOpportunity,
                            {
                                contactId: recipient.id,
                                contactName: recipient.name,
                                campaignId,
                                ownerId: undefined,
                            }
                        );

                        if (opportunityId) {
                            await ctx.runMutation(internal.messages.setOpportunityId, {
                                campaignId,
                                recipientId: recipient.id,
                                opportunityId,
                            });
                        }
                    } catch (oppErr) {
                        console.error(`Failed to create opportunity for ${recipient.id}:`, oppErr);
                    }
                }
            } else {
                await emit([{ recipientId: recipient.id, success: false, error: r.error }]);
            }
        }

        if (i + SUB_BATCH < prepared.length && interBatchDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, interBatchDelayMs));
        }
    }

    // Fire CRM logging as a background job so it never blocks the send loop.
    if (crmQueue.length > 0) {
        await ctx.scheduler.runAfter(0, internal.campaignQueue.logEmailBatchToCRM, {
            entries: crmQueue,
        });
    }

    return { nextDelayMs: emailBatchDelayMs() };
}

export const emailSender: ChannelSender = {
    channel: "email",
    errorRetryDelayMs: Math.max(emailBatchDelayMs(), 10000),
    sendBatch: sendEmailBatch_,
};
