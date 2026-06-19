import { v } from "convex/values";
import { internal, api } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { checkAccessHelper } from "./users";
import { batchProcessorFor } from "./lib/channelDispatch";

// Constants for batch sizing.
// EMAIL_BATCH_SIZE is the # of recipients per campaign batch. With Graph $batch
// (20 sub-requests per HTTP call, see lib/graph_client.sendEmailBatch), a 100-
// recipient batch is 5 $batch calls — well under Convex's 10-min action timeout
// even when 429 retries lengthen things. Previous value (250) was sized for the
// per-recipient send loop with a 1.2s sleep.
export const EMAIL_BATCH_SIZE = 100;
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
        attachments: v.optional(
            v.array(
                v.object({
                    name: v.string(),
                    contentType: v.string(),
                    storageId: v.optional(v.id("_storage")),
                    contentBase64: v.optional(v.string()),
                    isInline: v.optional(v.boolean()),
                    contentId: v.optional(v.string()), // Added explicit contentId
                })
            )
        ),
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

            // Create message records so the frontend can display them and tracking can link to them
            for (const recipient of batchRecipients) {
                await ctx.db.insert("messages", {
                    campaignId: args.campaignId,
                    recipientId: recipient.id,
                    recipientEmail: recipient.email,
                    recipientPhone: recipient.phone,
                    recipientName: recipient.name,
                    status: "pending",
                    channel: args.channel,
                });
            }
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

        // Set an initial heartbeat alongside startedAt so a freshly claimed batch
        // has a live lease (see lib/batchLease) before its worker's first emit.
        const claimedAt = Date.now();
        await ctx.db.patch(args.batchId, {
            status: "processing",
            startedAt: claimedAt,
            heartbeatAt: claimedAt,
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
 * Bump a batch's heartbeat so its lease (see lib/batchLease) stays live while a
 * worker is actively emitting results. Called by the Channel Send driver — not
 * adapters — and throttled there via `shouldBeat`, so writes stay bounded.
 */
export const beatBatch = internalMutation({
    args: { batchId: v.id("campaignBatches") },
    handler: async (ctx, args) => {
        await ctx.db.patch(args.batchId, { heartbeatAt: Date.now() });
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
        attachments: v.optional(
            v.array(
                v.object({
                    name: v.string(),
                    contentType: v.string(),
                    storageId: v.optional(v.id("_storage")),
                    contentBase64: v.optional(v.string()),
                    isInline: v.optional(v.boolean()),
                    contentId: v.optional(v.string()), // Added for CID matching
                })
            )
        ),
        whatsappTemplateId: v.optional(v.id("whatsappTemplates")),
        variableValues: v.optional(v.string()),
        createDynamicsActivity: v.optional(v.boolean()),
        fromMailbox: v.optional(v.string()),
        ccEmail: v.optional(v.string()),
        bccEmail: v.optional(v.string()),
        aiPrompt: v.optional(v.string()),
        aiSystemPrompt: v.optional(v.string()),
        createOpportunities: v.optional(v.boolean()),
        fontSize: v.optional(v.string()),
        scheduledAt: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
            throw new Error("Unauthenticated");
        }

        // --- ADDED: Email Sender Restriction ---
        if (args.fromMailbox) {
            const user = await ctx.db
                .query("users")
                .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
                .first();

            if (!user) {
                throw new Error("User record not found");
            }

            if (user.role !== "admin") {
                // Non-admins can only send using their own email or the primary shared mailbox (if allowed, but requirements say "only their own")
                // Let's enforce strictly that it must match their registered email address
                if (args.fromMailbox.toLowerCase() !== user.email.toLowerCase()) {
                    throw new Error("Unauthorized: You can only send emails from your own email address.");
                }
            }
        }
        // ---------------------------------------

        const recipients = args.recipients || [];

        const isScheduled =
            args.scheduledAt !== undefined && args.scheduledAt > Date.now();

        const campaignId = await ctx.db.insert("campaigns", {
            name: args.name,
            channel: args.channel,
            status: isScheduled ? "scheduled" : "queued",
            totalRecipients: recipients.length,
            sentCount: 0,
            deliveredCount: 0,
            failedCount: 0,
            createdBy: identity.subject,
            subject: args.subject,
            whatsappTemplateId: args.whatsappTemplateId,
            createDynamicsActivity: args.createDynamicsActivity,
            fromMailbox: args.fromMailbox,
            ccEmail: args.ccEmail,
            bccEmail: args.bccEmail,
            createOpportunities: args.createOpportunities,
            scheduledAt: args.scheduledAt,
        });

        // Store large content fields separately to keep campaign docs lightweight
        // for list/dashboard queries.
        await ctx.db.insert("campaignContent", {
            campaignId,
            htmlBody: args.htmlBody,
            attachments: args.attachments,
            filters: args.filters,
            variableValues: args.variableValues,
            aiPrompt: args.aiPrompt,
            aiSystemPrompt: args.aiSystemPrompt,
            fontSize: args.fontSize,
        });

        // Messages are now created downstream in createBatches for both direct and filtered campaigns.

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

/**
 * Fetches the large content fields for a campaign.
 * Falls back to reading from the campaign document itself for campaigns
 * created before the campaignContent table was introduced.
 */
export const getCampaignContent = internalQuery({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        const content = await ctx.db
            .query("campaignContent")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .first();
        if (content) return content;

        // Backward compat: old campaigns stored content on the campaign doc
        const campaign = await ctx.db.get(args.campaignId);
        if (!campaign) return null;
        return {
            campaignId: args.campaignId,
            htmlBody: (campaign as any).htmlBody as string | undefined,
            attachments: (campaign as any).attachments as any[] | undefined,
            content: (campaign as any).content as string | undefined,
            filters: (campaign as any).filters as string | undefined,
            filterCriteria: (campaign as any).filterCriteria as string | undefined,
            variableValues: (campaign as any).variableValues as string | undefined,
            aiPrompt: (campaign as any).aiPrompt as string | undefined,
            aiSystemPrompt: (campaign as any).aiSystemPrompt as string | undefined,
            fontSize: (campaign as any).fontSize as string | undefined,
        };
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
 *
 * Safety: only schedules ONE worker per campaign (not per batch) to prevent the
 * cascading worker-multiplication that caused duplicate sends in the past.
 * Individual recipient dedup in processEmailBatch ensures recovered batches
 * don't re-send to recipients whose status was already flushed.
 */
export const recoverStuckBatches = internalMutation({
    args: {},
    handler: async (ctx) => {
        const stuckThreshold = Date.now() - 20 * 60 * 1000; // 20 minutes

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

        // Re-schedule ONE worker per affected campaign.
        // Check that there are no OTHER batches still actively processing for this
        // campaign — if there are, the existing worker chain will pick up the
        // recovered batch naturally without us spawning a duplicate.
        for (const campaignId of recoveredCampaignIds) {
            const campaign = await ctx.db.get(campaignId);
            if (!campaign || (campaign.status !== "processing" && campaign.status !== "queued")) {
                continue;
            }

            // If another batch for this campaign is still processing, the active
            // worker chain will pick up the recovered (now pending) batch after it
            // finishes.  Don't spawn a second chain.
            const stillProcessing = await ctx.db
                .query("campaignBatches")
                .withIndex("by_campaign_status", (q) =>
                    q.eq("campaignId", campaignId).eq("status", "processing")
                )
                .first();
            if (stillProcessing) {
                console.log(`Skipping worker schedule for campaign ${campaignId} — another batch is still processing`);
                continue;
            }

            await ctx.scheduler.runAfter(0, batchProcessorFor(campaign.channel), {
                campaignId,
            });
        }

        if (recoveredCampaignIds.size > 0) {
            console.log(`Recovered ${recoveredCampaignIds.size} stuck campaign(s)`);
        }

        return { recovered: recoveredCampaignIds.size };
    },
});
