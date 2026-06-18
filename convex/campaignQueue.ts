"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { ShimmedContact, CampaignFilters } from "./lib/dynamics_util";
import { batchProcessorFor, handleBatchError } from "./lib/channelDispatch";
import { runChannelSend } from "./lib/channelSend";
import { emailSender, whatsappSender } from "./channelSenders";

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

        // Fetch large content fields from the separate content table
        const campaignContent = await ctx.runQuery(internal.campaignBatches.getCampaignContent, {
            campaignId: args.campaignId,
        });

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
            const { generatePersonalisedCopy } = await import("./lib/claude");
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
                        systemPrompt: campaignContent?.aiSystemPrompt || DEFAULT_SYS_PROMPT,
                        userPrompt: campaignContent?.aiPrompt || "",
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
            await handleBatchError(ctx, {
                channel: "personalised",
                campaignId: args.campaignId,
                batchId: batch._id,
                err,
                retryDelayMs: 500,
            });
        }
    },
});
