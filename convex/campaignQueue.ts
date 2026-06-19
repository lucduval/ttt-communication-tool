"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { ShimmedContact, CampaignFilters } from "./lib/dynamics_util";
import { batchProcessorFor } from "./lib/channelDispatch";
import { runChannelSend } from "./lib/channelSend";
import { emailSender, whatsappSender, personalisedSender } from "./channelSenders";

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
        scheduledAt: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const access = await ctx.runQuery(api.users.checkAccess);
        if (!access.hasAccess) throw new Error("Unauthorized");

        // If a future scheduledAt is set, defer batch creation/processing until then.
        // The campaign row itself was already inserted with status "scheduled" by
        // startCampaign, so the user can see it pending in the UI.
        if (args.scheduledAt && args.scheduledAt > Date.now()) {
            await ctx.scheduler.runAt(
                args.scheduledAt,
                internal.campaignQueue.kickoffScheduledCampaign,
                {
                    campaignId: args.campaignId,
                    recipients: args.recipients,
                    attachments: args.attachments,
                    channel: args.channel,
                    filters: args.filters,
                }
            );
            return { success: true, scheduled: true, scheduledAt: args.scheduledAt };
        }

        if (args.filters) {
            await ctx.scheduler.runAfter(0, internal.campaignQueue.processCampaignFilters, {
                campaignId: args.campaignId,
                filters: args.filters,
                channel: args.channel,
                attachments: args.attachments, // Pass attachments to processCampaignFilters
            });
            return { success: true };
        }

        if (!args.recipients || args.recipients.length === 0) {
            // No recipients and no filters — mark campaign as failed
            await ctx.runMutation(internal.campaigns.updateStatus, {
                campaignId: args.campaignId,
                status: "failed",
            });
            console.error(`Campaign ${args.campaignId} has no recipients and no filters — marked as failed`);
            return { success: false, error: "No recipients provided" };
        }

        if (args.recipients.length > 0) {
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

            // A single email worker stays under the Graph IncomingBytes limit
            // (150 MB / 5 min per mailbox).
            await ctx.scheduler.runAfter(0, batchProcessorFor(args.channel), {
                campaignId: args.campaignId,
            });
        }

        return { success: true };
    },
});

/**
 * Internal entrypoint fired by the Convex scheduler when a scheduled campaign
 * reaches its send time. Mirrors queueCampaignBatches' work (no auth check, since
 * the user is no longer present) and flips the campaign from "scheduled" → "queued".
 */
export const kickoffScheduledCampaign = internalAction({
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
                    contentId: v.optional(v.string()),
                })
            )
        ),
        channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("personalised")),
        filters: v.optional(v.string()),
    },
    handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
        // Bail out if the campaign was paused/cancelled while waiting.
        const campaign: { status: string; name: string } | null = await ctx.runQuery(
            internal.campaignBatches.getCampaign,
            { campaignId: args.campaignId }
        );
        if (!campaign) {
            console.warn(`Scheduled kickoff: campaign ${args.campaignId} no longer exists`);
            return { success: false, error: "Campaign not found" };
        }
        if (campaign.status !== "scheduled") {
            console.warn(
                `Scheduled kickoff: campaign ${args.campaignId} is in status "${campaign.status}", skipping`
            );
            return { success: false, error: `Unexpected status ${campaign.status}` };
        }

        // Move into the regular queued state so the rest of the pipeline behaves
        // exactly like an immediate send.
        await ctx.runMutation(internal.campaigns.updateStatus, {
            campaignId: args.campaignId,
            status: "queued",
        });

        if (args.filters) {
            await ctx.scheduler.runAfter(0, internal.campaignQueue.processCampaignFilters, {
                campaignId: args.campaignId,
                filters: args.filters,
                channel: args.channel,
                attachments: args.attachments,
            });
            return { success: true };
        }

        if (!args.recipients || args.recipients.length === 0) {
            await ctx.runMutation(internal.campaigns.updateStatus, {
                campaignId: args.campaignId,
                status: "failed",
            });
            console.error(
                `Scheduled campaign ${args.campaignId} has no recipients and no filters — marked as failed`
            );
            return { success: false, error: "No recipients provided" };
        }

        let recipients = args.recipients;

        if (args.channel === "personalised" && campaign.name) {
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

        await ctx.runMutation(internal.campaignBatches.createBatches, {
            campaignId: args.campaignId,
            recipients,
            channel: args.channel,
            // @ts-ignore - schema validator may need updating, mirrors queueCampaignBatches
            attachments: args.attachments,
        });

        await ctx.scheduler.runAfter(0, batchProcessorFor(args.channel), {
            campaignId: args.campaignId,
        });

        return { success: true };
    },
});

/**
 * Process one email batch and schedule next.
 *
 * Thin worker: the batch lifecycle (claim, flush-every-25, mark-complete,
 * reschedule, mark-failed) lives in the Channel Send driver; the email-specific
 * send loop lives in the email Channel Sender. See PRD #8 (Channel Send).
 */
export const processEmailBatch = internalAction({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        await runChannelSend(ctx, { campaignId: args.campaignId, sender: emailSender });
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
 * Process one WhatsApp batch and schedule next.
 *
 * Thin worker: the batch lifecycle lives in the Channel Send driver and the
 * WhatsApp-specific send loop (rate limiter, header-media upload, Tina
 * notification, inline CRM logging, three-strike `halt`) lives in the WhatsApp
 * Channel Sender. See PRD #8 (Channel Send).
 */
export const processWhatsAppBatch = internalAction({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        await runChannelSend(ctx, { campaignId: args.campaignId, sender: whatsappSender });
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

        // Channel reachability is a typed Contact Query dimension derived from the
        // campaign's own channel — never persisted in the stored filters — so count
        // (client) and send (here) apply the same email/whatsapp eligibility clause.
        // personalised reaches email-addressable contacts, same as email.
        parsedFilters = {
            ...parsedFilters,
            reachableChannel: channel === "whatsapp" ? "whatsapp" : "email",
        };

        // Resolve ownerId for non-admins (scheduled action has no user context)
        const campaign = await ctx.runQuery(internal.campaignBatches.getCampaign, { campaignId });
        if (campaign) {
            const user = await ctx.runQuery(internal.users.getCurrentUserInternal, { clerkId: campaign.createdBy });
            if (user && user.role !== "admin" && user.dynamicsUserId) {
                parsedFilters = { ...parsedFilters, ownerId: user.dynamicsUserId };
            }
        }

        console.log(`Processing filter-based campaign ${campaignId} with filters:`, parsedFilters);

        try {
            const { fetchMatchingContacts, fetchMatchingContactsByTaxReturn, fetchMatchingContactsWithITA34 } = await import("./lib/dynamics_util");

            const hasTaxReturnFilters = parsedFilters.taxReturnMin != null;
            const hasITA34Filters = parsedFilters.incomeMin != null || parsedFilters.incomeMax != null ||
                parsedFilters.retirementFundMin != null || parsedFilters.retirementFundMax != null;

            const fetchFn = hasTaxReturnFilters
                ? fetchMatchingContactsByTaxReturn
                : hasITA34Filters
                    ? fetchMatchingContactsWithITA34
                    : fetchMatchingContacts;

            // For personalised campaigns, pre-fetch contacts already sent this campaign
            // so we can filter them out as we stream chunks from Dynamics
            let excludedPersonalisedIds = new Set<string>();
            if (channel === "personalised" && campaign) {
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

            // Build set of contact IDs the user explicitly excluded via individual unchecks
            const excludeContactIds = new Set<string>(parsedFilters.excludeContactIds ?? []);

            // We'll fetch in chunks of 500 to match email batch size
            // This loop handles fetching ALL matching contacts from Dynamics
            // and creating batches incrementally
            let pageCount = 0;
            let totalProcessed = 0;

            // We use a callback to process each chunk immediately.
            // Each Dynamics page can return up to 5000 contacts, which means
            // createBatches would insert thousands of documents in one mutation.
            // To stay under Convex's 4 MB/s write limit we sub-chunk into groups
            // of 500 and add a short delay between mutations.
            const SUB_CHUNK_SIZE = 500;

            await fetchFn(parsedFilters, async (chunk: ShimmedContact[]) => {
                pageCount++;
                if (chunk.length === 0) return;

                // Map to recipient format, filtering out dedup exclusions and user-excluded contacts
                const recipients = chunk
                    .filter((c) => !excludedPersonalisedIds.has(c.id) && !excludeContactIds.has(c.id))
                    .map(c => ({
                        id: c.id,
                        email: c.email ?? undefined,
                        phone: (c.internationalPhone || c.phone) ?? undefined,
                        name: c.fullName,
                        variables: JSON.stringify({
                            referralCode: c.referralCode,
                        }),
                    }));

                if (recipients.length === 0) return;

                // Write in sub-chunks to avoid hitting Convex write limits
                for (let i = 0; i < recipients.length; i += SUB_CHUNK_SIZE) {
                    const subChunk = recipients.slice(i, i + SUB_CHUNK_SIZE);
                    await ctx.runMutation(internal.campaignBatches.createBatches, {
                        campaignId,
                        recipients: subChunk,
                        channel,
                    });
                    // Brief pause between sub-chunks to spread writes
                    if (i + SUB_CHUNK_SIZE < recipients.length) {
                        await new Promise((resolve) => setTimeout(resolve, 500));
                    }
                }

                totalProcessed += recipients.length;
                console.log(`Processed chunk ${pageCount}: ${recipients.length} contacts (Total: ${totalProcessed})`);
            });

            // Update campaign total recipients count now that we know it
            await ctx.runMutation(internal.campaignBatches.updateTotalRecipients, {
                campaignId,
                count: totalProcessed
            });

            // Start processing the first batch. A single email worker stays under
            // the Graph IncomingBytes limit (150 MB / 5 min per mailbox).
            await ctx.scheduler.runAfter(0, batchProcessorFor(channel), {
                campaignId,
            });

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
 *
 * Thin worker: the batch lifecycle lives in the Channel Send driver and the
 * personalised-specific send loop (per-recipient tax fetch → RA scenario calc →
 * AI copy generation → build/track/send → opportunity creation, plus the
 * pending-message-record creation and the personalised-history dedup write)
 * lives in the personalised Channel Sender. See PRD #8 (Channel Send).
 */
export const processPersonalisedBatch = internalAction({
    args: { campaignId: v.id("campaigns") },
    handler: async (ctx, args) => {
        await runChannelSend(ctx, { campaignId: args.campaignId, sender: personalisedSender });
    },
});
