"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { ShimmedContact, CampaignFilters } from "./lib/dynamics_util";
import { getClickatellConfig, uploadClickatellMedia, normalizePhoneNumber } from "./lib/whatsapp";
import { isRetryableHttpStatus } from "./lib/retry";
import { logEmailActivity, logWhatsAppActivity } from "./lib/dynamics_logging";

/**
 * Queue batches for a campaign (called after startCampaign)
 */
export const queueCampaignBatches = action({
    args: {
        campaignId: v.id("campaigns"),
        recipients: v.optional(v.array(v.object({
            id: v.string(),
            email: v.optional(v.string()),
            phone: v.optional(v.string()),
            name: v.string(),
            variables: v.optional(v.string()),
        }))),
        attachments: v.optional(
            v.array(
                v.object({
                    name: v.string(),
                    contentType: v.string(),
                    storageId: v.optional(v.id("_storage")),
                    contentBase64: v.optional(v.string()),
                    isInline: v.optional(v.boolean()),
                    contentId: v.optional(v.string()), // Explicit mapping
                })
            )
        ),
        channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("personalised")),
        filters: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");
        if (args.filters) {
            await ctx.scheduler.runAfter(0, internal.campaignQueue.processCampaignFilters, {
                campaignId: args.campaignId,
                filters: args.filters,
                channel: args.channel,
                attachments: args.attachments, // Pass attachments to processCampaignFilters
            });
            return { success: true };
        }

        if (args.recipients && args.recipients.length > 0) {
            let recipients = args.recipients;

            // For personalised campaigns, filter out contacts already sent this campaign name
            if (args.channel === "personalised") {
                const campaign = await ctx.runQuery(internal.campaignBatches.getCampaign, {
                    campaignId: args.campaignId,
                });
                if (campaign?.name) {
                    const excludedArr = await ctx.runQuery(
                        internal.personalisedHistory.getContactIdsForCampaignName,
                        { campaignName: campaign.name }
                    );
                    const excludedIds = new Set(excludedArr);
                    const before = recipients.length;
                    recipients = recipients.filter((r) => !excludedIds.has(r.id));
                    const excluded = before - recipients.length;
                    if (excluded > 0) {
                        console.log(`Dedup: excluded ${excluded} contacts already sent "${campaign.name}"`);
                    }
                }
            }

            await ctx.runMutation(internal.campaignBatches.createBatches, {
                campaignId: args.campaignId,
                recipients,
                channel: args.channel,
                // @ts-ignore - The schema validator might need updating for createBatches but it's passed through
                attachments: args.attachments,
            });

            if (args.channel === "personalised") {
                await ctx.scheduler.runAfter(0, internal.campaignQueue.processPersonalisedBatch, {
                    campaignId: args.campaignId,
                });
            } else if (args.channel === "email") {
                // Single worker to stay under Graph IncomingBytes limit (150 MB / 5 min per mailbox).
                await ctx.scheduler.runAfter(0, internal.campaignQueue.processEmailBatch, {
                    campaignId: args.campaignId,
                });
            } else {
                await ctx.scheduler.runAfter(0, internal.campaignQueue.processWhatsAppBatch, {
                    campaignId: args.campaignId,
                });
            }
        }

        return { success: true };
    },
});

/**
 * Process one email batch and schedule next
 */
export const processEmailBatch = internalAction({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        // Get campaign details
        const campaign = await ctx.runQuery(internal.campaignBatches.getCampaign, {
            campaignId: args.campaignId,
        });

        if (!campaign) {
            console.error("Campaign not found:", args.campaignId);
            return;
        }

        if (campaign.status === "paused") {
            console.log("Campaign paused, stopping batch processing:", args.campaignId);
            return;
        }

        // Get next pending batch
        const batch = await ctx.runQuery(internal.campaignBatches.getNextPendingBatchInternal, {
            campaignId: args.campaignId,
        });

        if (!batch) {
            console.log("No more batches to process for campaign:", args.campaignId);
            return;
        }

        // Mark batch as processing (with idempotency guard)
        const { acquired } = await ctx.runMutation(internal.campaignBatches.markBatchProcessing, {
            batchId: batch._id,
        });

        if (!acquired) {
            // Another parallel worker claimed this batch. Re-schedule self to pick
            // up the next available batch, keeping the worker pool stable.
            await ctx.scheduler.runAfter(250, internal.campaignQueue.processEmailBatch, {
                campaignId: args.campaignId,
            });
            return;
        }

        let successCount = 0;
        let failedCount = 0;
        const results: Array<{ recipientId: string; success: boolean; error?: string }> = [];
        const crmQueue: Array<{ recipientId: string; subject: string; body: string }> = [];

        try {
            // Import sendEmail function dynamically
            const { sendEmail } = await import("./lib/graph_client");

            // Resolve attachments once per batch (not once per recipient).
            // Fetching from Convex storage on every recipient was the primary cause of
            // slow campaigns — each storageId attachment triggered a query + HTTP download
            // for every single email in the batch.
            const processedAttachments: Array<{
                name: string;
                contentType: string;
                contentBase64: string;
                isInline?: boolean;
                contentId?: string;
            }> = [];
            if (campaign.attachments) {
                for (const att of campaign.attachments) {
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

            // Process each recipient in the batch
            for (const recipient of batch.recipients) {
                // Strip whitespace and Unicode space characters (e.g. \u00a0 from Dynamics CRM)
                // that pass a truthiness check but are rejected by the Graph API.
                const cleanEmail = recipient.email?.replace(/[\u00a0\u200B-\u200D\uFEFF\s]/g, "");

                if (!cleanEmail || !cleanEmail.includes("@")) {
                    failedCount++;
                    results.push({
                        recipientId: recipient.id,
                        success: false,
                        error: `Invalid email address: "${recipient.email}"`,
                    });
                    continue;
                }

                try {
                    // Resolve merge field values for this recipient
                    const recipientFirstName = recipient.name?.split(" ")[0] || recipient.name || "";
                    const recipientFullName = recipient.name || "";
                    const recipientEmail = cleanEmail;

                    const applyMergeFields = (text: string) =>
                        text
                            .replace(/\{firstName\}/g, recipientFirstName)
                            .replace(/\{fullName\}/g, recipientFullName)
                            .replace(/\{email\}/g, recipientEmail);

                    // Append unsubscribe footer for marketing compliance
                    const siteUrl = process.env.CONVEX_SITE_URL || "";
                    const unsubscribeUrl = siteUrl
                        ? `${siteUrl}/unsubscribe?id=${recipient.id}`
                        : "";

                    // Apply merge fields to body before wrapping
                    const mergedHtmlBody = applyMergeFields(campaign.htmlBody || "");

                    // Generate full email HTML with wrapper
                    const { wrapEmail } = await import("./lib/emailLayout");
                    let emailBody = wrapEmail(
                        mergedHtmlBody + (unsubscribeUrl ? getUnsubscribeFooter(unsubscribeUrl) : ""),
                        campaign.subject || "Notification"
                    );

                    // Link rewriting and open tracking
                    if (siteUrl) {
                        const { rewriteEmailLinks } = await import("./lib/tracking_utils");
                        emailBody = (await rewriteEmailLinks(emailBody, siteUrl, args.campaignId, recipient.id)) as string;
                    }

                    // Apply merge fields to the subject too
                    const mergedSubject = applyMergeFields(campaign.subject || "");

                    const result = await sendEmail({
                        subject: mergedSubject,
                        body: emailBody,
                        toRecipients: [{ email: cleanEmail, name: recipient.name }],
                        attachments: processedAttachments,
                        fromMailbox: campaign.fromMailbox,
                        headers: {
                            "X-Campaign-ID": args.campaignId,
                            "X-Recipient-ID": recipient.id,
                        },
                    });

                    if (result.success) {
                        successCount++;
                        results.push({ recipientId: recipient.id, success: true });

                        // Queue CRM logging — written to Dynamics in a background job
                        // after this batch completes so it doesn't block the send loop.
                        if (campaign.createDynamicsActivity) {
                            crmQueue.push({
                                recipientId: recipient.id,
                                subject: campaign.subject || "",
                                body: campaign.htmlBody || "",
                            });
                        }
                    } else {
                        failedCount++;
                        results.push({
                            recipientId: recipient.id,
                            success: false,
                            error: result.error,
                        });
                    }

                    // Rate limiting: stay under Graph IncomingBytes (150 MB / 5 min per mailbox).
                    // Default 1200ms (~0.8 emails/sec) to avoid overload on large campaigns (19k+).
                    const emailDelayMs = Math.max(500, parseInt(process.env.GRAPH_EMAIL_DELAY_MS ?? "1200", 10) || 1200);
                    await new Promise((resolve) => setTimeout(resolve, emailDelayMs));
                } catch (err) {
                    failedCount++;
                    results.push({
                        recipientId: recipient.id,
                        success: false,
                        error: err instanceof Error ? err.message : "Unknown error",
                    });
                }

            }

            // Batch update message statuses
            await ctx.runMutation(internal.messages.updateStatusBatch, {
                campaignId: args.campaignId,
                updates: results.map((r) => ({
                    recipientId: r.recipientId,
                    status: r.success ? "sent" : "failed",
                    sentAt: r.success ? Date.now() : undefined,
                    errorMessage: r.error,
                })),
            });

            // Mark batch complete
            const { hasMoreBatches } = await ctx.runMutation(
                internal.campaignBatches.markBatchComplete,
                {
                    batchId: batch._id,
                    successCount,
                    failedCount,
                }
            );

            // Fire CRM logging as a background job so it never blocks the send loop.
            // Each batch schedules its own logging action independently.
            if (crmQueue.length > 0) {
                await ctx.scheduler.runAfter(0, internal.campaignQueue.logEmailBatchToCRM, {
                    entries: crmQueue,
                });
            }

            // Each worker self-schedules exactly one successor. Add delay between batches
            // to avoid Graph IncomingBytes overload (150 MB / 5 min per mailbox).
            if (hasMoreBatches) {
                const batchDelayMs = parseInt(process.env.GRAPH_BATCH_DELAY_MS ?? "3000", 10) || 3000;
                await ctx.scheduler.runAfter(batchDelayMs, internal.campaignQueue.processEmailBatch, {
                    campaignId: args.campaignId,
                });
            }
        } catch (err) {
            console.error("Batch processing error:", err);
            const { hasMoreBatches } = await ctx.runMutation(internal.campaignBatches.markBatchFailed, {
                batchId: batch._id,
                errorMessage: err instanceof Error ? err.message : "Unknown error",
            });

            if (hasMoreBatches) {
                // Longer delay after error to let Graph recover
                const batchDelayMs = parseInt(process.env.GRAPH_BATCH_DELAY_MS ?? "3000", 10) || 3000;
                await ctx.scheduler.runAfter(Math.max(batchDelayMs, 10000), internal.campaignQueue.processEmailBatch, {
                    campaignId: args.campaignId,
                });
            }
        }
    },
});

/**
 * Background action that writes email activity records to Dynamics CRM for a
 * completed batch. Runs independently from the send loop so CRM latency never
 * delays email delivery. Retries each contact up to 3 times before skipping.
 */
export const logEmailBatchToCRM = internalAction({
    args: {
        entries: v.array(
            v.object({
                recipientId: v.string(),
                subject: v.string(),
                body: v.string(),
            })
        ),
    },
    handler: async (_ctx, args) => {
        const { logEmailActivity } = await import("./lib/dynamics_logging");

        for (const entry of args.entries) {
            const maxAttempts = 3;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    await logEmailActivity(entry.recipientId, entry.subject, entry.body);
                    break;
                } catch (err) {
                    if (attempt === maxAttempts) {
                        console.error(
                            `CRM log failed after ${maxAttempts} attempts for ${entry.recipientId}:`,
                            err
                        );
                    } else {
                        await new Promise((r) => setTimeout(r, 500 * attempt));
                    }
                }
            }
        }
    },
});

/**
 * Process one WhatsApp batch and schedule next
 */
export const processWhatsAppBatch = internalAction({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        // Get campaign details
        const campaign = await ctx.runQuery(internal.campaignBatches.getCampaign, {
            campaignId: args.campaignId,
        });

        if (!campaign || !campaign.whatsappTemplateId) {
            console.error("Campaign or template not found:", args.campaignId);
            return;
        }

        if (campaign.status === "paused") {
            console.log("Campaign paused, stopping batch processing:", args.campaignId);
            return;
        }

        // Get template
        const template = await ctx.runQuery(internal.campaignBatches.getWhatsAppTemplate, {
            templateId: campaign.whatsappTemplateId,
        });

        if (!template) {
            console.error("WhatsApp template not found");
            return;
        }

        // Get next pending batch
        const batch = await ctx.runQuery(internal.campaignBatches.getNextPendingBatchInternal, {
            campaignId: args.campaignId,
        });

        if (!batch) {
            console.log("No more batches to process for campaign:", args.campaignId);
            return;
        }

        // Mark batch as processing (with idempotency guard)
        const { acquired } = await ctx.runMutation(internal.campaignBatches.markBatchProcessing, {
            batchId: batch._id,
        });

        if (!acquired) {
            // Batch was already picked up by another action invocation, skip
            return;
        }

        let successCount = 0;
        let failedCount = 0;
        const results: Array<{ recipientId: string; success: boolean; messageSid?: string; error?: string }> = [];

        try {
            const config = getClickatellConfig();

            // Prepare Header (Upload if needed just ONCE for the batch)
            let headerPayload: any = undefined;

            if (template.headerType && template.headerType !== "none") {
                if (template.headerType === "text" && template.headerText) {
                    headerPayload = {
                        type: "text",
                        text: template.headerText
                    };
                } else if (["image", "document", "video"].includes(template.headerType) && template.headerUrl) {
                    try {
                        console.log("Uploading batch header media...");
                        const fileName = template.headerUrl.split('/').pop() || "media_file";

                        // Use the first recipient's phone number from the batch for the upload
                        const phoneForUpload = batch.recipients.find((r: { phone?: string }) => r.phone)?.phone || "27123456789";
                        const toNumber = normalizePhoneNumber(phoneForUpload);

                        const fileId = await uploadClickatellMedia(config.apiKey, template.headerUrl, toNumber, fileName, true);

                        // Simplified Header Payload (works for all media types in One API)
                        headerPayload = {
                            type: "media",
                            media: { fileId }
                        };
                    } catch (e) {
                        console.error("Failed to upload batch header media:", e);
                        // If header fails, we might still want to try sending without it? 
                        // Or fail the batch? Probably fail as the template expects it.
                        throw new Error(`Batch header media upload failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }

            // Process in sub-batches of 50 (Clickatell limit)
            const subBatchSize = 50;

            for (let i = 0; i < batch.recipients.length; i += subBatchSize) {
                const subBatch = batch.recipients.slice(i, i + subBatchSize);

                // Build messages payload
                const messagesPayload = subBatch.map((recipient: { id: string; phone?: string; name: string; variables?: string }) => {
                    const toNumber = normalizePhoneNumber(recipient.phone || "");
                    let recipientVars: Record<string, string> = {};
                    if (recipient.variables) {
                        try {
                            recipientVars = JSON.parse(recipient.variables);
                        } catch {
                            console.warn(`Invalid JSON in recipient variables for ${recipient.id}, using empty object`);
                        }
                    }


                    const allVariables: Record<string, string> = {
                        name: recipient.name,
                        fullname: recipient.name,
                        first_name: recipient.name.split(" ")[0],
                        firstname: recipient.name.split(" ")[0],
                        mobilephone: recipient.phone || "",
                        riivo_referralcode: recipientVars.referralCode || "",
                        ...recipientVars,
                    };

                    const parameters: Record<string, string> = {};
                    template.variables.forEach((varName: string) => {
                        parameters[varName] = allVariables[varName] || "";
                    });

                    // Build template payload (Simplified API to match sendTestWhatsApp)
                    const templatePayload: any = {
                        templateName: template.name,
                        body: {
                            parameters: parameters
                        }
                    };

                    // Add header component if it exists
                    if (headerPayload) {
                        templatePayload.header = headerPayload;
                    }

                    return {
                        channel: "whatsapp",
                        to: toNumber,
                        template: templatePayload,
                        clientMessageId: recipient.id,
                    };
                });

                try {
                    const maxAttempts = 3;
                    const baseDelayMs = 1000;
                    let result: { messages: Array<{ accepted?: boolean; apiMessageId?: string; error?: unknown }> } | null = null;

                    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                        const response = await fetch(
                            "https://platform.clickatell.com/v1/message",
                            {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    Authorization: config.apiKey,
                                },
                                body: JSON.stringify({ messages: messagesPayload }),
                            }
                        );

                        if (response.ok) {
                            result = await response.json();
                            break;
                        }

                        const errorText = await response.text();

                        if (!isRetryableHttpStatus(response.status) || attempt === maxAttempts) {
                            throw new Error(`Clickatell API error: ${response.status} - ${errorText}`);
                        }

                        const delay = baseDelayMs * Math.pow(2, attempt - 1);
                        await new Promise((resolve) => setTimeout(resolve, delay));
                    }

                    if (!result) {
                        throw new Error("Clickatell API did not return a result");
                    }
                    const finalResult = result;
                    console.log("CLICKATELL QUEUE BATCH RESPONSE:", JSON.stringify(finalResult, null, 2));

                    for (let idx = 0; idx < finalResult.messages.length; idx++) {
                        const msg = finalResult.messages[idx];
                        const recipient = subBatch[idx];
                        if (msg.accepted) {
                            successCount++;
                            results.push({
                                recipientId: recipient.id,
                                success: true,
                                messageSid: msg.apiMessageId,
                            });

                            // Log to Dynamics CRM if enabled
                            if (campaign.createDynamicsActivity) {
                                try {
                                    await logWhatsAppActivity(
                                        recipient.id,
                                        template.name,
                                        template.body || ""
                                    );
                                } catch (e) {
                                    console.error(`CRM WhatsApp log failed for ${recipient.id}:`, e);
                                }
                            }
                        } else {
                            failedCount++;
                            results.push({
                                recipientId: recipient.id,
                                success: false,
                                error: JSON.stringify(msg.error),
                            });
                        }
                    }
                } catch (err) {
                    // Mark entire sub-batch as failed
                    subBatch.forEach((recipient: { id: string; phone?: string; name: string; variables?: string }) => {
                        failedCount++;
                        results.push({
                            recipientId: recipient.id,
                            success: false,
                            error: err instanceof Error ? err.message : "Unknown error",
                        });
                    });
                }

                // Small delay between sub-batches
                if (i + subBatchSize < batch.recipients.length) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            }

            // Batch update message statuses
            await ctx.runMutation(internal.messages.updateStatusBatch, {
                campaignId: args.campaignId,
                updates: results.map((r) => ({
                    recipientId: r.recipientId,
                    status: r.success ? "sent" : "failed",
                    sentAt: r.success ? Date.now() : undefined,
                    errorMessage: r.error,
                    externalMessageId: r.messageSid,
                })),
            });

            // Mark batch complete
            const { hasMoreBatches } = await ctx.runMutation(
                internal.campaignBatches.markBatchComplete,
                {
                    batchId: batch._id,
                    successCount,
                    failedCount,
                }
            );

            // Schedule next batch if there are more
            if (hasMoreBatches) {
                await ctx.scheduler.runAfter(500, internal.campaignQueue.processWhatsAppBatch, {
                    campaignId: args.campaignId,
                });
            }
        } catch (err) {
            console.error("Batch processing error:", err);
            const { hasMoreBatches } = await ctx.runMutation(internal.campaignBatches.markBatchFailed, {
                batchId: batch._id,
                errorMessage: err instanceof Error ? err.message : "Unknown error",
            });

            // Continue processing remaining batches even after a failure
            if (hasMoreBatches) {
                await ctx.scheduler.runAfter(500, internal.campaignQueue.processWhatsAppBatch, {
                    campaignId: args.campaignId,
                });
            }
        }
    },
});

/**
 * Background job to fetch contacts by filter and create batches
 */
export const processCampaignFilters = internalAction({
    args: {
        campaignId: v.id("campaigns"),
        filters: v.string(), // JSON stringified filters
        channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("personalised")),
        attachments: v.optional(
            v.array(
                v.object({
                    name: v.string(),
                    contentType: v.string(),
                    storageId: v.optional(v.id("_storage")), // Can originate from Storage
                    contentBase64: v.optional(v.string()),  // Or raw base64 (for inline templates)
                    isInline: v.optional(v.boolean()),
                    contentId: v.optional(v.string()), // Added explicit contentId
                })
            )
        ),
    },
    handler: async (ctx, args) => {
        const { filters, campaignId, channel } = args;
        let parsedFilters: CampaignFilters;
        try {
            parsedFilters = JSON.parse(filters);
        } catch (e) {
            console.error(`Invalid filters JSON for campaign ${campaignId}:`, filters);
            return; // Or mark campaign as failed
        }

        console.log(`Processing filter-based campaign ${campaignId} with filters:`, parsedFilters);

        try {
            // Import dynamically to avoid circular dependencies if any
            const { fetchMatchingContacts } = await import("./lib/dynamics_util");

            // For personalised campaigns, pre-fetch contacts already sent this campaign
            // so we can filter them out as we stream chunks from Dynamics
            let excludedPersonalisedIds = new Set<string>();
            if (channel === "personalised") {
                const campaign = await ctx.runQuery(internal.campaignBatches.getCampaign, { campaignId });
                if (campaign?.name) {
                    const excludedArr = await ctx.runQuery(
                        internal.personalisedHistory.getContactIdsForCampaignName,
                        { campaignName: campaign.name }
                    );
                    excludedPersonalisedIds = new Set(excludedArr);
                    if (excludedPersonalisedIds.size > 0) {
                        console.log(`Dedup: will exclude ${excludedPersonalisedIds.size} contacts already sent "${campaign.name}"`);
                    }
                }
            }

            // We'll fetch in chunks of 500 to match email batch size
            // This loop handles fetching ALL matching contacts from Dynamics
            // and creating batches incrementally
            let pageCount = 0;
            let totalProcessed = 0;

            // We use a callback to process each chunk immediately
            await fetchMatchingContacts(parsedFilters, async (chunk: ShimmedContact[]) => {
                pageCount++;
                if (chunk.length === 0) return;

                // Map to recipient format, filtering out dedup exclusions for personalised campaigns
                const recipients = chunk
                    .filter((c) => !excludedPersonalisedIds.has(c.id))
                    .map(c => ({
                        id: c.id,
                        email: c.email ?? undefined,
                        phone: (c.internationalPhone || c.phone) ?? undefined,
                        name: c.fullName,
                        variables: JSON.stringify({
                            referralCode: c.referralCode,
                        }), // Include referral code in variables
                    }));

                if (recipients.length === 0) return;

                // Create a batch for this chunk
                await ctx.runMutation(internal.campaignBatches.createBatches, {
                    campaignId,
                    recipients,
                    channel,
                });

                totalProcessed += recipients.length;
                console.log(`Processed chunk ${pageCount}: ${recipients.length} contacts (Total: ${totalProcessed})`);
            });

            // Update campaign total recipients count now that we know it
            await ctx.runMutation(internal.campaignBatches.updateTotalRecipients, {
                campaignId,
                count: totalProcessed
            });

            // Start processing the first batch
            if (channel === "personalised") {
                await ctx.scheduler.runAfter(0, internal.campaignQueue.processPersonalisedBatch, {
                    campaignId,
                });
            } else if (channel === "email") {
                // Single worker to stay under Graph IncomingBytes limit (150 MB / 5 min per mailbox).
                await ctx.scheduler.runAfter(0, internal.campaignQueue.processEmailBatch, {
                    campaignId,
                });
            } else {
                await ctx.scheduler.runAfter(0, internal.campaignQueue.processWhatsAppBatch, {
                    campaignId,
                });
            }

        } catch (error) {
            console.error("Error processing campaign filters:", error);

            // Mark the campaign as failed and notify the user
            await ctx.runMutation(internal.campaigns.updateStatus, {
                campaignId,
                status: "failed",
            });

            const campaign = await ctx.runQuery(internal.campaignBatches.getCampaign, { campaignId });
            if (campaign) {
                await ctx.runMutation(internal.notifications.create, {
                    userId: campaign.createdBy,
                    title: "Campaign Failed",
                    message: `Failed to fetch contacts for campaign "${campaign.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
                    type: "error",
                    link: `/campaigns/${campaignId}`,
                });
            }
        }
    }
});

/**
 * Process one personalised email batch and schedule next.
 * Each recipient: fetch tax data -> calculate options -> generate AI copy -> build template -> send.
 */
export const processPersonalisedBatch = internalAction({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const campaign = await ctx.runQuery(internal.campaignBatches.getCampaign, {
            campaignId: args.campaignId,
        });

        if (!campaign) {
            console.error("Campaign not found:", args.campaignId);
            return;
        }

        if (campaign.status === "paused") {
            console.log("Campaign paused, stopping batch processing:", args.campaignId);
            return;
        }

        const batch = await ctx.runQuery(internal.campaignBatches.getNextPendingBatchInternal, {
            campaignId: args.campaignId,
        });

        if (!batch) {
            console.log("No more batches to process for personalised campaign:", args.campaignId);
            return;
        }

        const { acquired } = await ctx.runMutation(internal.campaignBatches.markBatchProcessing, {
            batchId: batch._id,
        });

        if (!acquired) return;

        let successCount = 0;
        let failedCount = 0;
        const results: Array<{ recipientId: string; success: boolean; error?: string }> = [];

        const DEFAULT_SYS_PROMPT = "You are a friendly and professional tax advisor at TTT Group. Write warm but concise emails. Do NOT invent or change any numbers.";

        try {
            const { dynamicsRequest } = await import("./lib/dynamics_auth");
            const { calculateOptions, parseAgeFromIdNumber } = await import("./lib/taxCalculator");
            const { generatePersonalisedCopy } = await import("./lib/gemini");
            const { buildPersonalisedEmail } = await import("./lib/emailTemplatePersonalised");
            const { sendEmail } = await import("./lib/graph_client");

            const ITA34_SEL = "riivo_ita34id,riivo_yearofassessment,riivo_income,riivo_taxableincomeassessedloss,riivo_retirementannuityfundcontributions,riivo_retirementfundcontributions,riivo_providendfundcontributions,riivo_medicalschemefeestaxcredit,riivo_medicalrebatebelow65withnodisability,riivo_dateofassessment,riivo_referencenumber";
            const IRP5_SEL = "riivo_irp5id,riivo_assessmentyearint,riivo_incomepaye,riivo_grosstaxableincome,riivo_totaldeductionscontributions,riivo_racontributions,riivo_providentfundcontributionpaye,riivo_totalprovidentfundcontributions,riivo_medicalaidcontributions,riivo_medicalschemetaxcredit,riivo_taxabletravelremuneration,riivo_employertradingothername,riivo_taxperiodstartdate,riivo_taxperiodenddate";

            // Create pending message records so click/open tracking and setOpportunityId can find them
            await ctx.runMutation(internal.messages.createBatch, {
                messages: batch.recipients.map((r) => ({
                    campaignId: args.campaignId,
                    recipientId: r.id,
                    recipientEmail: r.email ?? undefined,
                    recipientName: r.name,
                    status: "pending",
                    channel: "personalised" as const,
                })),
            });

            for (const recipient of batch.recipients) {
                try {
                    // 1. Fetch tax data
                    const [ita34Res, irp5Res, contactRes] = await Promise.all([
                        dynamicsRequest<{ value: any[] }>(
                            `riivo_ita34s?$select=${ITA34_SEL}&$filter=_riivo_taxpayercontact_value eq '${recipient.id}'&$orderby=riivo_yearofassessment desc&$top=1`
                        ),
                        dynamicsRequest<{ value: any[] }>(
                            `riivo_irp5s?$select=${IRP5_SEL}&$filter=_riivo_client_value eq '${recipient.id}'&$orderby=riivo_assessmentyearint desc&$top=1`
                        ),
                        dynamicsRequest<{ fullname: string; firstname: string | null; ttt_idnumber: string | null; riivo_age: number | null }>(
                            `contacts(${recipient.id})?$select=fullname,firstname,ttt_idnumber,riivo_age`
                        ),
                    ]);

                    const ita34 = ita34Res.value[0];
                    if (!ita34) {
                        failedCount++;
                        results.push({ recipientId: recipient.id, success: false, error: "No ITA34 data" });
                        continue;
                    }

                    const taxProfile = {
                        contactId: recipient.id,
                        ita34: {
                            yearOfAssessment: ita34.riivo_yearofassessment ?? 0,
                            income: ita34.riivo_income ?? 0,
                            taxableIncome: ita34.riivo_taxableincomeassessedloss ?? 0,
                            raContributions: ita34.riivo_retirementannuityfundcontributions ?? 0,
                            retirementFundContributions: ita34.riivo_retirementfundcontributions ?? 0,
                            providentFundContributions: ita34.riivo_providendfundcontributions ?? 0,
                            medicalSchemeTaxCredit: ita34.riivo_medicalschemefeestaxcredit ?? 0,
                            medicalRebate: ita34.riivo_medicalrebatebelow65withnodisability ?? 0,
                            dateOfAssessment: ita34.riivo_dateofassessment ?? null,
                            referenceNumber: ita34.riivo_referencenumber ?? null,
                        },
                        irp5: irp5Res.value[0] ? {
                            assessmentYear: irp5Res.value[0].riivo_assessmentyearint ?? 0,
                            incomePaye: irp5Res.value[0].riivo_incomepaye ?? 0,
                            grossTaxableIncome: irp5Res.value[0].riivo_grosstaxableincome ?? 0,
                            totalDeductions: irp5Res.value[0].riivo_totaldeductionscontributions ?? 0,
                            raContributions: irp5Res.value[0].riivo_racontributions ?? null,
                            providentFundContribution: irp5Res.value[0].riivo_providentfundcontributionpaye ?? 0,
                            totalProvidentFund: irp5Res.value[0].riivo_totalprovidentfundcontributions ?? 0,
                            medicalAidContributions: irp5Res.value[0].riivo_medicalaidcontributions ?? 0,
                            medicalSchemeTaxCredit: irp5Res.value[0].riivo_medicalschemetaxcredit ?? 0,
                            taxableTravel: irp5Res.value[0].riivo_taxabletravelremuneration ?? 0,
                            employerName: irp5Res.value[0].riivo_employertradingothername ?? null,
                            taxPeriodStart: irp5Res.value[0].riivo_taxperiodstartdate ?? null,
                            taxPeriodEnd: irp5Res.value[0].riivo_taxperiodenddate ?? null,
                        } : null,
                    };

                    // 2. Calculate tax scenarios (with age from ID number for retirement projection)
                    const age = (contactRes.ttt_idnumber ? parseAgeFromIdNumber(contactRes.ttt_idnumber) : null) ?? contactRes.riivo_age;
                    const scenarios = calculateOptions(taxProfile, age);
                    const recipientFirstName = contactRes.firstname || contactRes.fullname || recipient.name;

                    // 3. Generate AI copy
                    const targetYear = new Date().getFullYear() + 1;
                    const copy = await generatePersonalisedCopy({
                        systemPrompt: campaign.aiSystemPrompt || DEFAULT_SYS_PROMPT,
                        userPrompt: campaign.aiPrompt || "",
                        scenarios: {
                            recipientName: recipientFirstName,
                            yearOfAssessment: scenarios.yearOfAssessment,
                            targetYear,
                            currentIncome: scenarios.currentSituation.income,
                            currentTaxableIncome: scenarios.currentSituation.taxableIncome,
                            currentRaContribution: scenarios.currentSituation.currentRa,
                            maxAllowableRa: scenarios.currentSituation.maxAllowableRa,
                            currentTaxLiability: scenarios.currentSituation.taxLiability,
                            optionA: { additionalRa: scenarios.optionA.additionalRaContribution, monthlyRa: scenarios.optionA.monthlyAdditionalRa, taxSaving: scenarios.optionA.taxSaving, newTaxLiability: scenarios.optionA.taxAfter },
                            optionB: { additionalRa: scenarios.optionB.additionalRaContribution, monthlyRa: scenarios.optionB.monthlyAdditionalRa, taxSaving: scenarios.optionB.taxSaving, newTaxLiability: scenarios.optionB.taxAfter },
                            optionC: { additionalRa: scenarios.optionC.additionalRaContribution, monthlyRa: scenarios.optionC.monthlyAdditionalRa, taxSaving: scenarios.optionC.taxSaving, newTaxLiability: scenarios.optionC.taxAfter },
                            retirementProjection: scenarios.retirementProjection ?? undefined,
                        },
                    });

                    // 4. Build final HTML
                    const queueSiteUrl = process.env.CONVEX_SITE_URL ?? "";
                    const queueLogoUrl = queueSiteUrl ? `${queueSiteUrl}/logo` : undefined;
                    let emailBody = buildPersonalisedEmail({
                        copy,
                        scenarios,
                        recipientName: recipientFirstName,
                        yearOfAssessment: scenarios.yearOfAssessment,
                        targetYear,
                        logoUrl: queueLogoUrl,
                        siteUrl: queueSiteUrl,
                    });

                    // 5. Add tracking
                    const siteUrl = process.env.CONVEX_SITE_URL || "";
                    if (siteUrl) {
                        const { rewriteEmailLinks } = await import("./lib/tracking_utils");
                        emailBody = (await rewriteEmailLinks(emailBody, siteUrl, args.campaignId, recipient.id)) as string;
                    }

                    // 6. Build subject
                    const subjectTemplate = campaign.subject || "{firstName}, your personalised RA plan";
                    const emailSubject = subjectTemplate.replace(/\{firstName\}/g, recipientFirstName);

                    // 7. Send
                    const result = await sendEmail({
                        subject: emailSubject,
                        body: emailBody,
                        toRecipients: [{ email: recipient.email!, name: recipient.name }],
                        ccRecipients: campaign.ccEmail
                            ? [{ email: campaign.ccEmail }]
                            : undefined,
                        bccRecipients: campaign.bccEmail
                            ? [{ email: campaign.bccEmail }]
                            : undefined,
                        attachments: [],
                        fromMailbox: campaign.fromMailbox,
                        headers: {
                            "X-Campaign-ID": args.campaignId,
                            "X-Recipient-ID": recipient.id,
                        },
                    });

                    if (result.success) {
                        successCount++;
                        results.push({ recipientId: recipient.id, success: true });

                        // 8. Create CRM opportunity if enabled
                        if (campaign.createOpportunities) {
                            try {
                                const opportunityId = await ctx.runAction(
                                    internal.actions.dynamics.createOpportunity,
                                    {
                                        contactId: recipient.id,
                                        contactName: recipient.name,
                                        campaignId: args.campaignId,
                                        ownerId: undefined,
                                    }
                                );

                                if (opportunityId) {
                                    await ctx.runMutation(internal.messages.setOpportunityId, {
                                        campaignId: args.campaignId,
                                        recipientId: recipient.id,
                                        opportunityId,
                                    });
                                }
                            } catch (oppErr) {
                                console.error(`Failed to create opportunity for ${recipient.id}:`, oppErr);
                            }
                        }
                    } else {
                        failedCount++;
                        results.push({ recipientId: recipient.id, success: false, error: result.error });
                    }

                    // 1.5s between recipients — keeps Gemini well under 40 RPM
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                } catch (err) {
                    failedCount++;
                    results.push({
                        recipientId: recipient.id,
                        success: false,
                        error: err instanceof Error ? err.message : "Unknown error",
                    });
                }
            }

            // Batch update message statuses
            const sentAt = Date.now();
            await ctx.runMutation(internal.messages.updateStatusBatch, {
                campaignId: args.campaignId,
                updates: results.map((r) => ({
                    recipientId: r.recipientId,
                    status: r.success ? "sent" : "failed",
                    sentAt: r.success ? sentAt : undefined,
                    errorMessage: r.error,
                })),
            });

            // Record successful sends in personalised campaign history (enables dedup for future campaigns)
            const successfulRecipients = results.filter((r) => r.success);
            if (successfulRecipients.length > 0 && campaign.name) {
                await ctx.runMutation(internal.personalisedHistory.recordSentBatch, {
                    records: successfulRecipients.map((r) => ({
                        contactId: r.recipientId,
                        campaignId: args.campaignId,
                        campaignName: campaign.name,
                        sentAt,
                    })),
                });
            }

            const { hasMoreBatches } = await ctx.runMutation(
                internal.campaignBatches.markBatchComplete,
                { batchId: batch._id, successCount, failedCount }
            );

            if (hasMoreBatches) {
                await ctx.scheduler.runAfter(500, internal.campaignQueue.processPersonalisedBatch, {
                    campaignId: args.campaignId,
                });
            }
        } catch (err) {
            console.error("Personalised batch processing error:", err);
            const { hasMoreBatches } = await ctx.runMutation(internal.campaignBatches.markBatchFailed, {
                batchId: batch._id,
                errorMessage: err instanceof Error ? err.message : "Unknown error",
            });

            if (hasMoreBatches) {
                await ctx.scheduler.runAfter(500, internal.campaignQueue.processPersonalisedBatch, {
                    campaignId: args.campaignId,
                });
            }
        }
    },
});

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
