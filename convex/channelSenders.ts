"use node";

import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { ChannelSender, DriverBatch, EmitFn, MarkAttemptedFn } from "./lib/channelSend";
import {
    getMetaWhatsAppConfig,
    normalizeToE164Digits,
    buildTemplateRequestBody,
    sendTemplateWithRetry,
    isTemplatePermanentError,
    isMediaHeaderType,
    isMediaIdFresh,
    shouldRefreshMediaId,
    uploadWhatsAppMedia,
    parseRowBag,
    resolveRowVariables,
    RateLimiter,
    type TemplateLike,
    type MetaSendResult,
} from "./lib/whatsapp";
import { logWhatsAppActivity } from "./lib/dynamics_logging";
import { notifyTinaOfOutboundTemplate, substitutedBodyVariables } from "./lib/notifyTina";
import { applyMerge } from "./lib/applyMerge";
import {
    chunkByPayload,
    base64Size,
    MAX_BATCH_PAYLOAD_BYTES,
    MAX_BATCH_SUBREQUESTS,
} from "./lib/batchChunker";

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
    _batch: DriverBatch,
    emit: EmitFn,
    eligible: DriverBatch["recipients"],
    markAttempted: MarkAttemptedFn
): Promise<{ halt?: string; nextDelayMs?: number }> {
    const campaignId = campaign._id as Id<"campaigns">;

    const campaignContent = await ctx.runQuery(internal.campaignBatches.getCampaignContent, {
        campaignId,
    });

    // Per-recipient invoice-PDF attachment references (PRD bad-debt-excel-campaign,
    // #69). Each entry is a `generated` recipient's `storageId` + stored file size;
    // the bytes are fetched from storage at send (per chunk) and base64-inlined as a
    // Graph fileAttachment, so the file — not Dynamics — is the source of truth. The
    // size lets the payload-aware chunker plan chunks without downloading anything.
    // Empty for any non-upload campaign, so this path is inert there.
    const pdfRefs = (await ctx.runQuery(internal.invoicePdfs.getGeneratedPdfRefs, {
        campaignId,
    })) as Array<{ recipientId: string; storageId: Id<"_storage">; size: number }> | null | undefined;
    const pdfRefByRecipient = new Map(
        (pdfRefs ?? []).map((ref) => [ref.recipientId, ref] as const),
    );

    // `eligible` is the driver-provided set of recipients with no existing
    // `messages` row for this campaign, or a row still `pending` — the seed
    // createBatches writes up front (the send-path idempotency seam core, PRD
    // #55 / #56 / #63). Iterating it — rather than re-querying a
    // sent/delivered-only guard — is what makes batch processing at-most-once
    // across a crash/timeout recovery: an already-handled recipient
    // (`attempted`/`sent`/`delivered`/`failed`) is never here, so it is never
    // re-sent, while a fresh campaign's all-`pending` recipients all send.

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

    // Campaign-level attachments are shared by every message, so their base64
    // payload is a constant contribution to each message's chunking size.
    const campaignAttachmentsBytes = processedAttachments.reduce(
        (sum, att) => sum + att.contentBase64.length,
        0,
    );

    // Phase 1: validate + render every eligible recipient. Invalid recipients
    // are recorded as failures up-front so they never reach the $batch call.
    const siteUrl = process.env.CONVEX_SITE_URL || "";
    type PreparedSend = {
        recipient: { id: string; email?: string; name: string };
        message: Parameters<typeof sendEmailBatch>[0][number];
        /** This recipient's invoice-PDF reference, fetched + inlined per chunk at send. */
        pdfRef?: { storageId: Id<"_storage">; size: number };
        /** Estimated `$batch` payload bytes for this message — feeds the chunker's byte budget. */
        payloadBytes: number;
    };
    const prepared: PreparedSend[] = [];

    for (const recipient of eligible) {
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

            // Excel-driven campaigns (PRD bad-debt-excel-campaign, #66): the
            // per-recipient `variables` bag carries the full uploaded row, keyed
            // by column header, and is the source of truth for `{column}` merge —
            // no Dynamics re-fetch on this path. Non-upload campaigns have no bag,
            // so only the built-in fields below resolve, preserving prior behaviour.
            const rowVariables: Record<string, string> = {};
            if (recipient.variables) {
                try {
                    const parsed = JSON.parse(recipient.variables);
                    if (parsed && typeof parsed === "object") {
                        for (const [k, val] of Object.entries(parsed)) {
                            rowVariables[k.trim()] = val == null ? "" : String(val);
                        }
                    }
                } catch {
                    // Malformed bag → no row variables; built-ins still resolve.
                }
            }
            // Row columns are the source of truth: they override the built-ins when
            // a header collides (e.g. an export column literally named `email`).
            const rowContext: Record<string, string> = {
                firstName: recipientFirstName,
                fullName: recipientFullName,
                email: recipientEmail,
                ...rowVariables,
            };

            const applyMergeFields = (text: string) => applyMerge(text, rowContext);

            const unsubscribeUrl = siteUrl ? `${siteUrl}/unsubscribe?id=${recipient.id}` : "";

            const mergedHtmlBody = applyMergeFields(campaignContent?.htmlBody || "");
            // Merge the subject first: wrapEmail embeds it as the document title
            // inside the body, so an un-merged subject would leak a raw
            // `{placeholder}` into the body (PRD #66 — nothing raw ever ships).
            const mergedSubject = applyMergeFields(campaign.subject || "");

            let emailBody = wrapEmail(
                mergedHtmlBody + (unsubscribeUrl ? getUnsubscribeFooter(unsubscribeUrl) : ""),
                mergedSubject || "Notification",
                campaignContent?.fontSize || "15px"
            );

            if (siteUrl) {
                emailBody = (await rewriteEmailLinks(emailBody, siteUrl, campaignId, recipient.id)) as string;
            }

            const pdfRef = pdfRefByRecipient.get(recipient.id);
            // Chunking size ≈ body + subject + shared campaign attachments + this
            // recipient's own PDF (as base64). The PDF bytes aren't downloaded yet —
            // only its size feeds the byte budget; the fetch happens per chunk below.
            const payloadBytes =
                Buffer.byteLength(emailBody, "utf8") +
                Buffer.byteLength(mergedSubject, "utf8") +
                campaignAttachmentsBytes +
                (pdfRef ? base64Size(pdfRef.size) : 0);

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
                pdfRef,
                payloadBytes,
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

    // Phase 2: send via Microsoft Graph $batch. The payload-aware chunker enforces
    // BOTH Graph's ≤20 sub-request cap AND a ~3 MB cumulative-payload budget, so
    // once each message carries its own invoice PDF, larger PDFs simply mean fewer
    // messages per chunk (#69). Per-item 429/5xx retries are handled inside
    // sendEmailBatch; IncomingBytes throttling is expected and accepted.
    const interBatchDelayMs = Math.max(
        0,
        parseInt(process.env.GRAPH_EMAIL_INTER_BATCH_DELAY_MS ?? "200", 10) || 0
    );

    const chunks = chunkByPayload(prepared, (p) => p.payloadBytes, {
        maxCount: MAX_BATCH_SUBREQUESTS,
        maxBytes: MAX_BATCH_PAYLOAD_BYTES,
    });

    // Fetch one recipient's invoice-PDF bytes from Convex storage and base64-inline
    // them onto its message as a Graph fileAttachment. Reverses the old
    // "resolve attachments once per batch" optimisation deliberately: the file is
    // now per-recipient. Returns false if the fetch fails so the caller can settle
    // that recipient `failed` rather than send an attachment-less invoice email.
    const attachRecipientPdf = async (item: PreparedSend): Promise<boolean> => {
        if (!item.pdfRef) return true; // no PDF for this recipient (e.g. non-upload campaign)
        try {
            const fileUrl = await ctx.runQuery(internal.files.getDownloadUrlInternal, {
                storageId: item.pdfRef.storageId,
            });
            if (!fileUrl) throw new Error("No download URL for stored invoice PDF");
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error(`Storage fetch ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const contentBase64 = Buffer.from(arrayBuffer).toString("base64");
            item.message.attachments = [
                ...(item.message.attachments ?? []),
                {
                    name: `invoice-${item.recipient.id}.pdf`,
                    contentType: "application/pdf",
                    contentBase64,
                    isInline: false,
                },
            ];
            return true;
        } catch (err) {
            console.error(`Failed to fetch invoice PDF for ${item.recipient.id}:`, err);
            return false;
        }
    };

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];

        // Per-recipient storage fetches are parallelised WITHIN the chunk (#69):
        // resolve every recipient's PDF concurrently, then settle any fetch failure
        // `failed` and drop it — it must never be handed to Graph without its
        // invoice attached. Doing this before markAttempted keeps the durable
        // marker landing immediately before the send, covering only recipients
        // actually sent.
        const attachResults = await Promise.all(chunk.map((item) => attachRecipientPdf(item)));
        const slice: PreparedSend[] = [];
        for (let k = 0; k < chunk.length; k++) {
            if (attachResults[k]) {
                slice.push(chunk[k]);
            } else {
                await emit([
                    {
                        recipientId: chunk[k].recipient.id,
                        success: false,
                        error: "Failed to fetch invoice PDF from storage",
                    },
                ]);
            }
        }
        if (slice.length === 0) continue;

        // Durably mark this chunk `attempted` BEFORE handing it to Graph (PRD #55
        // / #58). A worker crash after this point but before the chunk's response
        // is settled leaves at most this chunk's recipients in `attempted` — the
        // eligibility rule (#56) then declines to auto-resend them, bounding the
        // blast radius of a crash to one chunk instead of a mass re-send. The
        // chunk holds only validated recipients whose PDF fetched cleanly;
        // pre-flight invalids and fetch failures were recorded `failed` and never
        // reach here.
        await markAttempted(slice.map((p) => p.recipient.id));

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

        if (chunkIdx + 1 < chunks.length && interBatchDelayMs > 0) {
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
    emit: EmitFn,
    eligible: DriverBatch["recipients"],
    markAttempted: MarkAttemptedFn
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

    // Every variable the payload builder needs a value for: each positional body
    // variable, plus any dynamic URL button whose {{1}} is substituted per
    // recipient (the payment token/URL suffix on the Excel-driven path — Meta
    // reconstructs approved-prefix + suffix).
    const buttonVars = [template.buttonUrlVariable, template.button2UrlVariable].filter(
        (v): v is string => !!v
    );

    // Two source-of-truth modes share one send loop (PRD prd-bad-debt-excel-campaign.md,
    // issue #70). An uploaded-file campaign (columnRoles set) resolves every variable —
    // body + button suffix — from the recipient's own uploaded row, and sends that
    // recipient's pre-generated invoice PDF as the document header (uploaded to Meta per
    // recipient → media id, only the id cached — never bytes). Every other campaign
    // resolves variables from Dynamics against the template's shared header, unchanged.
    const isUpload = !!campaign.columnRoles;

    // Per-recipient resolver: the variables map + the (possibly per-recipient) template
    // to send, or a terminal per-recipient error. Runs inside the rate-limiter slot so
    // the per-recipient Meta media upload is bounded by maxConcurrent, not fanned out
    // across the whole (up to 1000-recipient) batch at once.
    type Resolved = { allVariables: Record<string, string>; templateForSend: TemplateLike };
    let resolveForRecipient: (
        recipient: DriverBatch["recipients"][number]
    ) => Promise<Resolved | { error: string }>;

    if (isUpload) {
        // The template variable → Excel column mapping lives on the campaign (mapped
        // once per campaign), not the template. Missing/malformed → resolve by column
        // name (the validation gate holds un-renderable rows upstream).
        let variableMappings: Record<string, string> = {};
        if (campaign.whatsappVariableMappings) {
            try {
                variableMappings = JSON.parse(campaign.whatsappVariableMappings);
            } catch {
                console.warn(
                    `Invalid whatsappVariableMappings JSON on campaign ${campaignId}; resolving variables by column name`
                );
            }
        }
        const names = [...template.variables, ...buttonVars];

        // Per-recipient invoice-PDF references (#68/#69): the storageId to fetch the
        // bytes from, plus any cached Meta media id so a recovery re-run skips the
        // re-upload while the id is still fresh.
        const pdfRefs = await ctx.runQuery(internal.invoicePdfs.getWhatsAppPdfRefs, {
            campaignId,
        });
        const pdfRefByRecipient = new Map(pdfRefs.map((r) => [r.recipientId, r] as const));
        // Only a media header (document, for the invoice PDF) needs a per-recipient
        // upload; a text/none header does not.
        const mediaHeader = isMediaHeaderType(template.headerType);

        resolveForRecipient = async (recipient) => {
            const rowBag = parseRowBag(recipient.variables);
            const allVariables = resolveRowVariables(names, variableMappings, rowBag);

            if (!mediaHeader) {
                return { allVariables, templateForSend: { ...(template as TemplateLike) } };
            }

            const ref = pdfRefByRecipient.get(recipient.id);
            if (!ref) {
                return { error: "No generated invoice PDF for recipient (document header cannot be sent)" };
            }

            // Reuse a still-fresh cached media id; otherwise upload the stored PDF bytes
            // to Meta and cache the returned id (never the bytes) for a re-run.
            let mediaId = ref.whatsappMediaId;
            if (!mediaId || !isMediaIdFresh(ref.whatsappMediaIdUploadedAt)) {
                const url = await ctx.runQuery(internal.files.getDownloadUrlInternal, {
                    storageId: ref.storageId,
                });
                if (!url) {
                    return { error: "Invoice PDF file missing from storage" };
                }
                const upload = await uploadWhatsAppMedia(config, {
                    sourceUrl: url,
                    headerType: template.headerType as "image" | "video" | "document",
                    mimeTypeOverride: "application/pdf",
                });
                mediaId = upload.mediaId;
                await ctx.runMutation(internal.invoicePdfs.recordWhatsAppMediaId, {
                    campaignId,
                    recipientId: recipient.id,
                    whatsappMediaId: mediaId,
                    uploadedAt: Date.now(),
                });
            }

            return {
                allVariables,
                templateForSend: {
                    ...(template as TemplateLike),
                    headerMediaId: mediaId,
                    headerFilename: "invoice.pdf",
                },
            };
        };
    } else {
        // Dynamics-resolved path (unchanged): variableMappings on the template maps
        // each variable (named or positional) to a Dynamics field; button variables
        // are field names too. The UI "Fill in Template Variables" form only feeds
        // test sends — real send time reads the CRM.
        let variableMappings: Record<string, string> = {};
        if (template.variableMappings) {
            try {
                variableMappings = JSON.parse(template.variableMappings);
            } catch {
                console.warn(`Invalid variableMappings JSON on template ${template._id}; resolving variables by name`);
            }
        }
        // For each template variable, the Dynamics field to read. Falls back to the
        // variable name itself (generic-by-field-name) for templates whose variable
        // names already are logical field names (e.g. riivo_referralcode).
        const varToField: Record<string, string> = {};
        for (const varName of template.variables) {
            varToField[varName] = variableMappings[varName] || varName;
        }
        const neededFields = [...Object.values(varToField), ...buttonVars];
        const { fetchContactFieldsByIds } = await import("./lib/dynamics_util");
        // Send only to the driver-computed eligible set (the send-path idempotency
        // seam, PRD #55 / #56 / #61): a recipient already handled — `attempted`,
        // `sent`, `delivered`, or a terminal `failed` — is never here, so an
        // ambiguous Meta response settled `failed` is never auto-resent on a
        // recovery re-run, while a fresh campaign's `pending` recipients all send.
        const crmFieldMap = await fetchContactFieldsByIds(
            eligible.map((r) => r.id),
            neededFields
        );

        resolveForRecipient = async (recipient) => {
            const crm = crmFieldMap.get(recipient.id) ?? {};
            // Resolve a Dynamics field for this recipient, with sensible fallbacks
            // derived from the recipient record so name/phone still work for
            // non-contact audiences (leads/employees) that have no Dynamics contact row.
            const resolveField = (field: string): string => {
                const fromCrm = crm[field];
                if (fromCrm) return fromCrm;
                switch (field) {
                    case "fullname":
                        return recipient.name;
                    case "firstname":
                        return recipient.name.split(" ")[0];
                    case "lastname":
                        return recipient.name.split(" ").slice(1).join(" ");
                    case "mobilephone":
                        return recipient.phone || "";
                    default:
                        return "";
                }
            };
            const allVariables: Record<string, string> = {};
            for (const varName of template.variables) {
                allVariables[varName] = resolveField(varToField[varName]);
            }
            for (const bv of buttonVars) {
                allVariables[bv] = resolveField(bv);
            }
            return { allVariables, templateForSend };
        };
    }

    await Promise.all(
        eligible.map(async (recipient) => {
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

            // Resolve variables + (for upload campaigns) upload the per-recipient PDF,
            // then mark `attempted` and send — all inside one rate-limiter slot. Marking
            // inside the slot (PRD #55 / #58 / #61) means only recipients the limiter has
            // released are marked, so a mid-batch action kill strands at most the
            // in-flight recipients in `attempted`; the eligibility rule (#56) then
            // declines to auto-resend them, so an ambiguous Meta response is treated as
            // handed-off, never re-sent. Bounding the media upload here too keeps a
            // large batch from fanning out thousands of concurrent uploads.
            const outcome = await limiter.schedule(
                async (): Promise<
                    | { kind: "aborted" }
                    | { kind: "prep-error"; error: string }
                    | { kind: "sent-or-failed"; result: MetaSendResult; resolved: Resolved }
                > => {
                    if (templateAbortReason) return { kind: "aborted" };
                    let resolved: Resolved | { error: string };
                    try {
                        resolved = await resolveForRecipient(recipient);
                    } catch (err) {
                        return {
                            kind: "prep-error",
                            error: err instanceof Error ? err.message : "Failed to prepare message",
                        };
                    }
                    if ("error" in resolved) return { kind: "prep-error", error: resolved.error };

                    const body = buildTemplateRequestBody(
                        resolved.templateForSend,
                        toDigits,
                        resolved.allVariables
                    );
                    await markAttempted([recipient.id]);
                    const result = await sendTemplateWithRetry(config, body);
                    return { kind: "sent-or-failed", result, resolved };
                }
            );

            if (outcome.kind === "aborted") {
                await emit([
                    { recipientId: recipient.id, success: false, error: `Aborted: ${templateAbortReason}` },
                ]);
                return;
            }
            if (outcome.kind === "prep-error") {
                await emit([{ recipientId: recipient.id, success: false, error: outcome.error }]);
                return;
            }

            const { result, resolved } = outcome;

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
                    templateVariables: substitutedBodyVariables(
                        resolved.templateForSend.variables,
                        resolved.allVariables
                    ),
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
    emit: EmitFn,
    eligible: DriverBatch["recipients"],
    markAttempted: MarkAttemptedFn
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

    // Row creation is now the seam's, not the adapter's (PRD #55 / #61). The seed
    // `createBatches` writes a `pending` row per recipient up front (#63) — the
    // click/open-tracking and `setOpportunityId` reconciliation the personalised
    // path depends on — and `markAttempted` (below) advances that row to
    // `attempted` immediately before the send, so the row still exists throughout.
    // Iterating `eligible` rather than `batch.recipients` is what makes this path
    // at-most-once: a recipient already handled (`attempted`/`sent`/`delivered`/
    // `failed`) is not here, so an ambiguous Graph response settled `failed` is
    // never auto-resent on a recovery re-run, matching the email seam exactly.

    // The driver owns the result buffer, so track successful recipientIds locally
    // for the post-loop personalised-history dedup write.
    const successfulIds: string[] = [];

    for (const recipient of eligible) {
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

            // 7. Send. Mark `attempted` immediately BEFORE the Graph call (PRD #55
            // / #58 / #61): a crash between the mark and the response strands this
            // one recipient in `attempted`, which the eligibility rule (#56)
            // declines to auto-resend — the same crash-blast-radius guarantee the
            // email seam gives, one recipient at a time for this sequential path.
            await markAttempted([recipient.id]);
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
