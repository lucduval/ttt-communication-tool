import { v } from "convex/values";
import { internal, api } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { checkAccessHelper } from "./users";

// Constants for batch sizing
export const EMAIL_BATCH_SIZE = 250;
export const WHATSAPP_BATCH_SIZE = 1000;
export const PERSONALISED_BATCH_SIZE = 50;

/**
 * Create batches for a campaign and queue them for processing
 */
export const createBatches = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        recipients: v.array(v.object({
            id: v.string(),
            email: v.optional(v.string()),
            phone: v.optional(v.string()),
            name: v.string(),
            variables: v.optional(v.string()),
        })),
        channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("personalised")),
    },
    handler: async (ctx, args) => {
        const batchSize = args.channel === "personalised"
            ? PERSONALISED_BATCH_SIZE
            : args.channel === "email"
                ? EMAIL_BATCH_SIZE
                : WHATSAPP_BATCH_SIZE;

        // Count existing batches to continue numbering correctly
        // (for filter-based campaigns where createBatches is called multiple times)
        const existingBatches = await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();
        const existingBatchCount = existingBatches.length;

        const newBatchCount = Math.ceil(args.recipients.length / batchSize);
        const totalBatches = existingBatchCount + newBatchCount;

        for (let i = 0; i < newBatchCount; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, args.recipients.length);
            const batchRecipients = args.recipients.slice(start, end);

            await ctx.db.insert("campaignBatches", {
                campaignId: args.campaignId,
                batchNumber: existingBatchCount + i + 1,
                totalBatches,
                status: "pending",
                recipients: batchRecipients,
                processedCount: 0,
                successCount: 0,
                failedCount: 0,
            });
        }

        // Only reset currentBatch on the first call
        const patchData: Record<string, unknown> = {
            totalBatches,
            status: "queued",
        };
        if (existingBatchCount === 0) {
            patchData.currentBatch = 0;
        }
        await ctx.db.patch(args.campaignId, patchData);

        return { totalBatches };
    },
});

/**
 * Get next pending batch for a campaign (public query for frontend)
 */
export const getNextPendingBatch = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");

        return await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign_status", (q) =>
                q.eq("campaignId", args.campaignId).eq("status", "pending")
            )
            .first();
    },
});

/**
 * Get all batches for a campaign (for progress display)
 */
export const getBatches = query({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const access = await checkAccessHelper(ctx);
        if (!access.hasAccess) throw new Error("Unauthorized");

        return await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .collect();
    },
});

/**
 * Mark a batch as processing
 */
export const markBatchProcessing = internalMutation({
    args: { batchId: v.id("campaignBatches") },
    handler: async (ctx, args) => {
        const batch = await ctx.db.get(args.batchId);
        if (!batch) return { acquired: false };

        // Idempotency guard: only transition from "pending" to "processing"
        if (batch.status !== "pending") {
            return { acquired: false };
        }

        await ctx.db.patch(args.batchId, {
            status: "processing",
            startedAt: Date.now(),
        });

        // Update campaign status
        const campaign = await ctx.db.get(batch.campaignId);
        if (campaign) {
            // Only update status and notify if this is the first batch starting
            if (campaign.status === "queued") {
                await ctx.db.patch(batch.campaignId, {
                    currentBatch: batch.batchNumber,
                    status: "processing",
                });

                // Notify user
                await ctx.runMutation(internal.notifications.create, {
                    userId: campaign.createdBy,
                    title: "Campaign Started",
                    message: `Your campaign "${campaign.name}" has started processing.`,
                    type: "info",
                    link: `/campaigns/${batch.campaignId}`,
                });
            } else {
                await ctx.db.patch(batch.campaignId, {
                    currentBatch: batch.batchNumber,
                });
            }
        }

        return { acquired: true };
    },
});

/**
 * Mark a batch as completed and update campaign stats
 */
export const markBatchComplete = internalMutation({
    args: {
        batchId: v.id("campaignBatches"),
        successCount: v.number(),
        failedCount: v.number(),
    },
    handler: async (ctx, args) => {
        const batch = await ctx.db.get(args.batchId);
        if (!batch) return { hasMoreBatches: false };

        await ctx.db.patch(args.batchId, {
            status: "completed",
            completedAt: Date.now(),
            processedCount: args.successCount + args.failedCount,
            successCount: args.successCount,
            failedCount: args.failedCount,
        });

        const campaign = await ctx.db.get(batch.campaignId);
        if (campaign) {
            await ctx.db.patch(batch.campaignId, {
                sentCount: (campaign.sentCount || 0) + args.successCount + args.failedCount,
                deliveredCount: (campaign.deliveredCount || 0) + args.successCount,
                failedCount: (campaign.failedCount || 0) + args.failedCount,
            });
        }

        const pendingBatches = await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign_status", (q) =>
                q.eq("campaignId", batch.campaignId).eq("status", "pending")
            )
            .first();

        const processingBatches = await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign_status", (q) =>
                q.eq("campaignId", batch.campaignId).eq("status", "processing")
            )
            .first();

        if (!pendingBatches && !processingBatches) {
            await ctx.db.patch(batch.campaignId, { status: "completed" });

            // Notify user
            if (campaign) {
                await ctx.runMutation(internal.notifications.create, {
                    userId: campaign.createdBy,
                    title: "Campaign Completed",
                    message: `Your campaign "${campaign.name}" has finished sending.`,
                    type: "success",
                    link: `/campaigns/${batch.campaignId}`,
                });
            }
        }

        return { hasMoreBatches: !!pendingBatches };
    },
});

/**
 * Mark a batch as failed
 */
export const markBatchFailed = internalMutation({
    args: {
        batchId: v.id("campaignBatches"),
        errorMessage: v.string(),
    },
    handler: async (ctx, args) => {
        const batch = await ctx.db.get(args.batchId);
        if (!batch) return { hasMoreBatches: false };

        await ctx.db.patch(args.batchId, {
            status: "failed",
            completedAt: Date.now(),
            errorMessage: args.errorMessage,
            processedCount: batch.recipients.length,
            failedCount: batch.recipients.length,
        });

        const campaign = await ctx.db.get(batch.campaignId);
        if (campaign) {
            // Increment failedCount properly (not overwrite)
            await ctx.db.patch(batch.campaignId, {
                failedCount: (campaign.failedCount || 0) + batch.recipients.length,
                sentCount: (campaign.sentCount || 0) + batch.recipients.length,
            });
        }

        // Check if there are remaining pending batches
        const pendingBatch = await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign_status", (q) =>
                q.eq("campaignId", batch.campaignId).eq("status", "pending")
            )
            .first();

        const processingBatch = await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign_status", (q) =>
                q.eq("campaignId", batch.campaignId).eq("status", "processing")
            )
            .first();

        if (!pendingBatch && !processingBatch) {
            // All batches done — mark campaign as completed (with errors)
            await ctx.db.patch(batch.campaignId, { status: "completed" });

            if (campaign) {
                await ctx.runMutation(internal.notifications.create, {
                    userId: campaign.createdBy,
                    title: "Campaign Completed with Errors",
                    message: `Your campaign "${campaign.name}" has finished, but some batches failed. Error: ${args.errorMessage}`,
                    type: "warning",
                    link: `/campaigns/${batch.campaignId}`,
                });
            }
        } else if (campaign) {
            // More batches to process — notify about batch failure but continue
            await ctx.runMutation(internal.notifications.create, {
                userId: campaign.createdBy,
                title: "Batch Failed - Continuing",
                message: `A batch failed for campaign "${campaign.name}": ${args.errorMessage}. Continuing with remaining batches.`,
                type: "warning",
                link: `/campaigns/${batch.campaignId}`,
            });
        }

        return { hasMoreBatches: !!pendingBatch };
    },
});

/**
 * Start processing a campaign - creates campaign and message records
 */
export const startCampaign = mutation({
    args: {
        name: v.string(),
        channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("personalised")),
        recipients: v.optional(v.array(v.object({
            id: v.string(),
            email: v.optional(v.string()),
            phone: v.optional(v.string()),
            name: v.string(),
            variables: v.optional(v.string()),
        }))),
        filters: v.optional(v.string()),
        subject: v.optional(v.string()),
        htmlBody: v.optional(v.string()),
        attachments: v.optional(v.array(v.object({
            name: v.string(),
            contentType: v.string(),
            contentBase64: v.optional(v.string()),
            storageId: v.optional(v.id("_storage")),
            isInline: v.optional(v.boolean()),
        }))),
        whatsappTemplateId: v.optional(v.id("whatsappTemplates")),
        variableValues: v.optional(v.string()),
        createDynamicsActivity: v.optional(v.boolean()),
        fromMailbox: v.optional(v.string()),
        aiPrompt: v.optional(v.string()),
        aiSystemPrompt: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
            throw new Error("Unauthenticated");
        }

        const recipients = args.recipients || [];

        const campaignId = await ctx.db.insert("campaigns", {
            name: args.name,
            channel: args.channel,
            status: "queued",
            totalRecipients: recipients.length,
            sentCount: 0,
            deliveredCount: 0,
            failedCount: 0,
            createdBy: identity.subject,
            subject: args.subject,
            htmlBody: args.htmlBody,
            attachments: args.attachments,
            whatsappTemplateId: args.whatsappTemplateId,
            variableValues: args.variableValues,
            createDynamicsActivity: args.createDynamicsActivity,
            fromMailbox: args.fromMailbox,
            filters: args.filters,
            aiPrompt: args.aiPrompt,
            aiSystemPrompt: args.aiSystemPrompt,
        });

        // If recipients are provided directly, create message records immediately
        if (recipients.length > 0) {
            const channel = args.channel;
            for (const recipient of recipients) {
                await ctx.db.insert("messages", {
                    campaignId,
                    recipientId: recipient.id,
                    recipientEmail: recipient.email,
                    recipientPhone: recipient.phone,
                    recipientName: recipient.name,
                    status: "pending",
                    channel,
                });
            }
        }

        return campaignId;
    },
});

// Internal queries for actions to use
export const getCampaign = internalQuery({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        return await ctx.db.get(args.campaignId);
    },
});

export const getNextPendingBatchInternal = internalQuery({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("campaignBatches")
            .withIndex("by_campaign_status", (q) =>
                q.eq("campaignId", args.campaignId).eq("status", "pending")
            )
            .first();
    },
});


export const getWhatsAppTemplate = internalQuery({
    args: { templateId: v.id("whatsappTemplates") },
    handler: async (ctx, args) => {
        return await ctx.db.get(args.templateId);
    },
});

export const updateTotalRecipients = internalMutation({
    args: {
        campaignId: v.id("campaigns"),
        count: v.number(),
    },
    handler: async (ctx, args) => {
        await ctx.db.patch(args.campaignId, {
            totalRecipients: args.count,
        });
    },
});

/**
 * Recover batches stuck in "processing" state (e.g. after an action crash/timeout).
 * Resets them to "pending" so they can be retried, and re-schedules batch processing.
 */
export const recoverStuckBatches = internalMutation({
    args: {},
    handler: async (ctx) => {
        const stuckThreshold = Date.now() - 15 * 60 * 1000; // 15 minutes

        const processingBatches = await ctx.db
            .query("campaignBatches")
            .withIndex("by_status", (q) => q.eq("status", "processing"))
            .collect();

        const recoveredCampaignIds = new Set<Id<"campaigns">>();

        for (const batch of processingBatches) {
            if (batch.startedAt && batch.startedAt < stuckThreshold) {
                await ctx.db.patch(batch._id, {
                    status: "pending",
                    startedAt: undefined,
                });
                recoveredCampaignIds.add(batch.campaignId);
                console.log(`Recovered stuck batch ${batch._id} for campaign ${batch.campaignId}`);
            }
        }

        // Re-schedule batch processing for each affected campaign
        for (const campaignId of recoveredCampaignIds) {
            const campaign = await ctx.db.get(campaignId);
            if (campaign && (campaign.status === "processing" || campaign.status === "queued")) {
                if (campaign.channel === "personalised") {
                    await ctx.scheduler.runAfter(0, internal.campaignQueue.processPersonalisedBatch, {
                        campaignId,
                    });
                } else if (campaign.channel === "email") {
                    await ctx.scheduler.runAfter(0, internal.campaignQueue.processEmailBatch, {
                        campaignId,
                    });
                } else {
                    await ctx.scheduler.runAfter(0, internal.campaignQueue.processWhatsAppBatch, {
                        campaignId,
                    });
                }
            }
        }

        if (recoveredCampaignIds.size > 0) {
            console.log(`Recovered ${recoveredCampaignIds.size} stuck campaign(s)`);
        }

        return { recovered: recoveredCampaignIds.size };
    },
});
