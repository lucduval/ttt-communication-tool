"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { ShimmedContact, CampaignFilters } from "./lib/dynamics_util";
import { getClickatellConfig, uploadClickatellMedia } from "./lib/whatsapp";
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
        channel: v.union(v.literal("email"), v.literal("whatsapp")),
        filters: v.optional(v.string()), // New: Pass filters instead of recipients
    },
    handler: async (ctx, args) => {
        // If filters are provided, we need to fetch contacts and create batches asynchronously
        if (args.filters) {
            // Schedule the background job to fetch contacts and create batches
            // We use a new internal action for this to avoid timeout limits on the initial call
            await ctx.scheduler.runAfter(0, internal.campaignQueue.processCampaignFilters, {
                campaignId: args.campaignId,
                filters: args.filters,
                channel: args.channel,
            });
            return { success: true };
        }

        // Standard flow: create batches from provided recipients
        if (args.recipients && args.recipients.length > 0) {
            await ctx.runMutation(internal.campaignBatches.createBatches, {
                campaignId: args.campaignId,
                recipients: args.recipients,
                channel: args.channel,
            });

            // Schedule first batch processing
            if (args.channel === "email") {
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

        // Get next pending batch
        const batch = await ctx.runQuery(internal.campaignBatches.getNextPendingBatchInternal, {
            campaignId: args.campaignId,
        });

        if (!batch) {
            console.log("No more batches to process for campaign:", args.campaignId);
            return;
        }

        // Mark batch as processing
        await ctx.runMutation(internal.campaignBatches.markBatchProcessing, {
            batchId: batch._id,
        });

        let successCount = 0;
        let failedCount = 0;
        const results: Array<{ recipientId: string; success: boolean; error?: string }> = [];

        try {
            // Import sendEmail function dynamically
            const { sendEmail } = await import("./lib/graph_client");

            // Process each recipient in the batch
            for (const recipient of batch.recipients) {
                if (!recipient.email) {
                    failedCount++;
                    results.push({
                        recipientId: recipient.id,
                        success: false,
                        error: "No email address",
                    });
                    continue;
                }

                try {
                    // Prepare attachments (fetch from storage if needed)
                    const processedAttachments = [];
                    if (campaign.attachments) {
                        for (const att of campaign.attachments) {
                            let contentBase64 = att.contentBase64;

                            // If we have a storageId but no contentBase64, fetch it
                            if (att.storageId && !contentBase64) {
                                try {
                                    // fetching the url from our internal query
                                    const fileUrl = await ctx.runQuery(api.files.getDownloadUrl, {
                                        storageId: att.storageId
                                    });

                                    if (fileUrl) {
                                        const response = await fetch(fileUrl);
                                        const arrayBuffer = await response.arrayBuffer();
                                        contentBase64 = Buffer.from(arrayBuffer).toString('base64');
                                    }
                                } catch (e) {
                                    console.error(`Failed to fetch attachment ${att.name} from storage:`, e);
                                    // Skip this attachment or continue with empty content? 
                                    // better to continue so the email sends, maybe with a warning
                                }
                            }

                            if (contentBase64) {
                                processedAttachments.push({
                                    name: att.name,
                                    contentType: att.contentType,
                                    contentBase64: contentBase64,
                                    isInline: att.isInline
                                });
                            }
                        }
                    }

                    // Append unsubscribe footer for marketing compliance
                    const siteUrl = process.env.CONVEX_SITE_URL || "";
                    const unsubscribeUrl = siteUrl
                        ? `${siteUrl}/unsubscribe?id=${recipient.id}`
                        : "";
                    const emailBody = (campaign.htmlBody || "") + (unsubscribeUrl ? getUnsubscribeFooter(unsubscribeUrl) : "");

                    const result = await sendEmail({
                        subject: campaign.subject || "",
                        body: emailBody,
                        toRecipients: [{ email: recipient.email, name: recipient.name }],
                        attachments: processedAttachments,
                        fromMailbox: campaign.fromMailbox,
                    });

                    if (result.success) {
                        successCount++;
                        results.push({ recipientId: recipient.id, success: true });

                        // Log to Dynamics CRM if enabled
                        if (campaign.createDynamicsActivity) {
                            try {
                                await logEmailActivity(
                                    recipient.id,
                                    campaign.subject || "",
                                    campaign.htmlBody || ""
                                );
                            } catch (e) {
                                console.error(`CRM email log failed for ${recipient.id}:`, e);
                            }
                        }
                    } else {
                        failedCount++;
                        results.push({
                            recipientId: recipient.id,
                            success: false,
                            error: result.error,
                        });
                    }

                    // Rate limiting: 100ms between emails (10/sec)
                    await new Promise((resolve) => setTimeout(resolve, 100));
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

            // Schedule next batch if there are more
            if (hasMoreBatches) {
                await ctx.scheduler.runAfter(500, internal.campaignQueue.processEmailBatch, {
                    campaignId: args.campaignId,
                });
            }
        } catch (err) {
            console.error("Batch processing error:", err);
            await ctx.runMutation(internal.campaignBatches.markBatchFailed, {
                batchId: batch._id,
                errorMessage: err instanceof Error ? err.message : "Unknown error",
            });
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

        // Mark batch as processing
        await ctx.runMutation(internal.campaignBatches.markBatchProcessing, {
            batchId: batch._id,
        });

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
                        // or a dummy number if needed, but real number is safer for Clickatell validation
                        const firstRecipientPhone = batch.recipients[0]?.phone || "";
                        // If no phone in first recipient, we might have an issue, but we'll try to find one
                        const phoneForUpload = batch.recipients.find((r: any) => r.phone)?.phone || "1234567890";
                        const toNumber = phoneForUpload.replace(/\D/g, "");

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
                    const toNumber = (recipient.phone || "").replace(/\D/g, "");
                    const recipientVars = recipient.variables
                        ? JSON.parse(recipient.variables)
                        : {};


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

                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`Clickatell API error: ${response.status} - ${errorText}`);
                    }

                    const result = await response.json();

                    for (let idx = 0; idx < result.messages.length; idx++) {
                        const msg = result.messages[idx] as { accepted?: boolean; apiMessageId?: string; error?: unknown };
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
            await ctx.runMutation(internal.campaignBatches.markBatchFailed, {
                batchId: batch._id,
                errorMessage: err instanceof Error ? err.message : "Unknown error",
            });
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
        channel: v.union(v.literal("email"), v.literal("whatsapp")),
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

            // We'll fetch in chunks of 500 to match email batch size
            // This loop handles fetching ALL matching contacts from Dynamics
            // and creating batches incrementally
            let pageCount = 0;
            let totalProcessed = 0;

            // We use a callback to process each chunk immediately
            await fetchMatchingContacts(parsedFilters, async (chunk: ShimmedContact[]) => {
                pageCount++;
                if (chunk.length === 0) return;

                // Map to recipient format
                const recipients = chunk.map(c => ({
                    id: c.id,
                    email: c.email ?? undefined,
                    phone: (c.internationalPhone || c.phone) ?? undefined,
                    name: c.fullName,
                    variables: JSON.stringify({
                        referralCode: c.referralCode,
                    }), // Include referral code in variables
                }));

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
            if (channel === "email") {
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
            // We should probably mark the campaign as failed here if it hasn't started
        }
    }
});

/**
 * Generate an HTML unsubscribe footer for marketing email compliance.
 */
function getUnsubscribeFooter(unsubscribeUrl: string): string {
    return `
    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #718096; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
        <p style="margin: 4px 0;">You are receiving this email because you are a client of TTT.</p>
        <p style="margin: 4px 0;">
            If you no longer wish to receive these emails, you can
            <a href="${unsubscribeUrl}" style="color: #4299e1; text-decoration: underline;">unsubscribe here</a>.
        </p>
    </div>`;
}
