"use node";

import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { ChannelSender, DriverBatch, EmitFn } from "./lib/channelSend";
import {
    getMetaWhatsAppConfig,
    normalizeToE164Digits,
    buildTemplateRequestBody,
    sendTemplateWithRetry,
    isTemplatePermanentError,
    isMediaHeaderType,
    shouldRefreshMediaId,
    uploadWhatsAppMedia,
    RateLimiter,
    type TemplateLike,
} from "./lib/whatsapp";
import { logWhatsAppActivity } from "./lib/dynamics_logging";
import { notifyTinaOfOutboundTemplate, substitutedBodyVariables } from "./lib/notifyTina";

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

/**
 * WhatsApp Channel Sender. Owns the rate limiter, header-media upload, the Tina
 * notification, inline CRM logging, and the three-strike permanent-template-error
 * abort — surfaced as a `halt` so the driver stops scheduling a successor. Per-
 * recipient results stream to the driver via `emit`; flushing (now every 25,
 * the reliability win) is the driver's.
 */
async function sendWhatsAppBatch_(
    ctx: ActionCtx,
    campaign: any,
    batch: DriverBatch,
    emit: EmitFn
): Promise<{ halt?: string; nextDelayMs?: number }> {
    const campaignId = campaign._id as Id<"campaigns">;

    if (!campaign.whatsappTemplateId) {
        // A WhatsApp campaign with no template can never make progress; halt so the
        // driver does not schedule successor batches.
        return { halt: "WhatsApp campaign has no template" };
    }

    const template = await ctx.runQuery(internal.campaignBatches.getWhatsAppTemplate, {
        templateId: campaign.whatsappTemplateId,
    });
    if (!template) {
        return { halt: "WhatsApp template not found" };
    }

    const config = getMetaWhatsAppConfig();
    const limiter = new RateLimiter(config.maxSendPerSecond, config.maxConcurrent);

    // Upload header media to Meta if the template has one and the cached id is
    // missing/stale/stamped against a different URL. Re-running per batch is cheap
    // because shouldRefreshMediaId short-circuits once the id is cached.
    let headerMediaIdForSend: string | undefined = template.headerMediaId;
    if (isMediaHeaderType(template.headerType) && template.headerUrl) {
        const needsRefresh = shouldRefreshMediaId(
            {
                headerMediaId: template.headerMediaId,
                headerMediaIdUploadedAt: template.headerMediaIdUploadedAt,
                headerMediaSourceUrl: template.headerMediaSourceUrl,
            },
            template.headerUrl
        );
        if (needsRefresh) {
            try {
                const upload = await uploadWhatsAppMedia(config, {
                    sourceUrl: template.headerUrl,
                    headerType: template.headerType,
                    mimeTypeOverride: template.headerMediaMimeType,
                });
                await ctx.runMutation(internal.whatsappTemplates.setHeaderMediaCache, {
                    id: template._id,
                    mediaId: upload.mediaId,
                    mimeType: upload.mimeType,
                    sourceUrl: template.headerUrl,
                });
                headerMediaIdForSend = upload.mediaId;
            } catch (uploadErr) {
                const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
                console.error(`Header media upload failed for campaign ${campaignId}: ${msg}`);
                // Fall back to sending with the public URL (link) — the template still
                // works, just less reliably. A broken URL surfaces as a per-recipient
                // error and the existing 3-strike abort kicks in.
            }
        }
    }
    const templateForSend: TemplateLike = {
        ...(template as TemplateLike),
        headerMediaId: headerMediaIdForSend,
    };

    // Track 3-consecutive permanent template errors → abort the batch. Meta returns
    // 132xxx codes when a template is paused or has a variable mismatch; every
    // subsequent recipient hits the same error, so we stop early rather than burn
    // through the list. Surfaced as `halt` so the driver schedules no successor.
    let consecutiveTemplateErrors = 0;
    let templateAbortReason: string | null = null;

    await Promise.all(
        batch.recipients.map(async (recipient) => {
            if (templateAbortReason) {
                await emit([
                    { recipientId: recipient.id, success: false, error: `Aborted: ${templateAbortReason}` },
                ]);
                return;
            }

            const toDigits = normalizeToE164Digits(recipient.phone || "");
            if (!toDigits) {
                await emit([
                    {
                        recipientId: recipient.id,
                        success: false,
                        error: `Invalid phone number: ${recipient.phone || "(empty)"}`,
                    },
                ]);
                return;
            }

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

            // The payload builder picks body variables from template.variables and the
            // button variable from template.buttonUrlVariable, both from this map.
            const body = buildTemplateRequestBody(templateForSend, toDigits, allVariables);
            const result = await limiter.schedule(() => sendTemplateWithRetry(config, body));

            if (result.status === "sent") {
                consecutiveTemplateErrors = 0;
                await emit([
                    { recipientId: recipient.id, success: true, externalMessageId: result.wamid },
                ]);

                // Seed Tina's conversation history with this outbound so the client's
                // reply lands in context. Best-effort and deduped by wamid; awaited so
                // Convex does not tear the action down before the fetch resolves.
                await notifyTinaOfOutboundTemplate({
                    phone: toDigits,
                    templateName: template.name,
                    templateLanguage: template.language,
                    templateVariables: substitutedBodyVariables(templateForSend.variables, allVariables),
                    senderMessageId: result.wamid,
                    sender: "campaign_whatsapp",
                });

                if (campaign.createDynamicsActivity) {
                    try {
                        await logWhatsAppActivity(recipient.id, template.name, template.body || "");
                    } catch (e) {
                        console.error(`CRM WhatsApp log failed for ${recipient.id}:`, e);
                    }
                }
            } else {
                await emit([
                    {
                        recipientId: recipient.id,
                        success: false,
                        error: `code=${result.errorCode ?? "n/a"} ${result.errorMessage}`,
                    },
                ]);

                if (isTemplatePermanentError(result.errorCode)) {
                    consecutiveTemplateErrors++;
                    if (consecutiveTemplateErrors >= 3 && !templateAbortReason) {
                        templateAbortReason = `template '${template.name}' (${template.language}) hit 3 consecutive permanent errors (code ${result.errorCode}) — paused or misnamed`;
                        console.error(templateAbortReason);
                    }
                } else {
                    consecutiveTemplateErrors = 0;
                }
            }
        })
    );

    return { halt: templateAbortReason ?? undefined, nextDelayMs: 500 };
}

export const whatsappSender: ChannelSender = {
    channel: "whatsapp",
    errorRetryDelayMs: 500,
    sendBatch: sendWhatsAppBatch_,
};

const DEFAULT_SYS_PROMPT =
    "You are a friendly and professional tax advisor at TTT Group. Write warm but concise emails. Do NOT invent or change any numbers.";

/**
 * Personalised Channel Sender. Owns the sequential per-recipient pipeline —
 * fetch tax data (ITA34/IRP5/contact) → calculate RA scenarios → generate AI
 * copy (Claude) → build + track the email → send → opportunity creation — plus
 * the pending-message-record creation and the personalised-history dedup write.
 * Per-recipient results stream to the driver via `emit`; flushing, claim, and
 * lifecycle are the driver's. The 1.5s inter-recipient pacing keeps the AI
 * provider under its RPM ceiling.
 */
async function sendPersonalisedBatch_(
    ctx: ActionCtx,
    campaign: any,
    batch: DriverBatch,
    emit: EmitFn
): Promise<{ halt?: string; nextDelayMs?: number }> {
    const campaignId = campaign._id as Id<"campaigns">;

    const campaignContent = await ctx.runQuery(internal.campaignBatches.getCampaignContent, {
        campaignId,
    });

    const { dynamicsRequest } = await import("./lib/dynamics_auth");
    const { fetchTaxProfile } = await import("./lib/taxProfile");
    const { calculateOptions, parseAgeFromIdNumber } = await import("./lib/taxCalculator");
    const { generatePersonalisedCopy } = await import("./lib/claude");
    const { buildPersonalisedEmail } = await import("./lib/emailTemplatePersonalised");
    const { sendEmail } = await import("./lib/graph_client");

    // Create pending message records so click/open tracking and setOpportunityId can find them.
    await ctx.runMutation(internal.messages.createBatch, {
        messages: batch.recipients.map((r) => ({
            campaignId,
            recipientId: r.id,
            recipientEmail: r.email ?? undefined,
            recipientName: r.name,
            status: "pending" as const,
            channel: "personalised" as const,
        })),
    });

    // The driver owns the result buffer, so track successful recipientIds locally
    // for the post-loop personalised-history dedup write.
    const successfulIds: string[] = [];

    for (const recipient of batch.recipients) {
        try {
            // 1. Fetch tax data. The Tax Profile module owns the ITA34/IRP5 read,
            // latest-year selection, and field mapping; the contact lookup (name,
            // ID number, age) stays here because it isn't part of the tax profile.
            const [taxProfile, contactRes] = await Promise.all([
                fetchTaxProfile(recipient.id),
                dynamicsRequest<{ fullname: string; firstname: string | null; ttt_idnumber: string | null; riivo_age: number | null }>(
                    `contacts(${recipient.id})?$select=fullname,firstname,ttt_idnumber,riivo_age`
                ),
            ]);

            if (!taxProfile.ita34) {
                await emit([{ recipientId: recipient.id, success: false, error: "No ITA34 data" }]);
                continue;
            }

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
                emailBody = (await rewriteEmailLinks(emailBody, siteUrl, campaignId, recipient.id)) as string;
            }

            // 6. Build subject
            const subjectTemplate = campaign.subject || "{firstName}, your personalised RA plan";
            const emailSubject = subjectTemplate.replace(/\{firstName\}/g, recipientFirstName);

            // 7. Send
            const result = await sendEmail({
                subject: emailSubject,
                body: emailBody,
                toRecipients: [{ email: recipient.email!, name: recipient.name }],
                ccRecipients: campaign.ccEmail ? [{ email: campaign.ccEmail }] : undefined,
                bccRecipients: campaign.bccEmail ? [{ email: campaign.bccEmail }] : undefined,
                attachments: [],
                fromMailbox: campaign.fromMailbox,
                headers: {
                    "X-Campaign-ID": campaignId,
                    "X-Recipient-ID": recipient.id,
                },
            });

            if (result.success) {
                successfulIds.push(recipient.id);
                await emit([{ recipientId: recipient.id, success: true }]);

                // 8. Create CRM opportunity if enabled
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
                await emit([{ recipientId: recipient.id, success: false, error: result.error }]);
            }

            // 1.5s between recipients — keeps Gemini well under 40 RPM
            await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch (err) {
            // One recipient's failure must not kill the batch.
            await emit([
                {
                    recipientId: recipient.id,
                    success: false,
                    error: err instanceof Error ? err.message : "Unknown error",
                },
            ]);
        }
    }

    // Record successful sends in personalised campaign history (enables dedup for future campaigns).
    if (successfulIds.length > 0 && campaign.name) {
        const sentAt = Date.now();
        await ctx.runMutation(internal.personalisedHistory.recordSentBatch, {
            records: successfulIds.map((contactId) => ({
                contactId,
                campaignId,
                campaignName: campaign.name,
                sentAt,
            })),
        });
    }

    return { nextDelayMs: 500 };
}

export const personalisedSender: ChannelSender = {
    channel: "personalised",
    errorRetryDelayMs: 500,
    sendBatch: sendPersonalisedBatch_,
};
