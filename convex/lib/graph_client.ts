/**
 * Microsoft Graph API client for sending emails
 * Uses client credentials flow (service principal)
 */

import { isRetryableHttpStatus } from "./retry";

interface TokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
}

let cachedGraphToken: { token: string; expiresAt: number } | null = null;

/**
 * Get an access token for Microsoft Graph API
 */
export async function getGraphAccessToken(): Promise<string> {
    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID || process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.GRAPH_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
        throw new Error(
            "Missing required environment variables for Graph API: AZURE_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET"
        );
    }

    // Check if we have a valid cached token (with 5-minute buffer)
    if (cachedGraphToken && cachedGraphToken.expiresAt > Date.now() + 5 * 60 * 1000) {
        return cachedGraphToken.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
    });

    const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to acquire Graph token: ${response.status} - ${errorText}`);
    }

    const data: TokenResponse = await response.json();

    // Cache the token
    cachedGraphToken = {
        token: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
    };

    return data.access_token;
}

export interface EmailAttachment {
    name: string;
    contentType: string;
    contentBase64: string; // Base64 encoded content
    isInline?: boolean;
    contentId?: string; // Explicit content ID for inline images to ensure exact match
}

/**
 * Parse Retry-After header (seconds or HTTP-date). Returns null if unparseable.
 */
export function parseRetryAfter(value: string | null): number | null {
    if (!value?.trim()) return null;
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
    try {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
            const sec = Math.ceil((date.getTime() - Date.now()) / 1000);
            return Math.max(0, sec);
        }
    } catch {
        /* ignore */
    }
    return null;
}

export interface EmailMessage {
    subject: string;
    body: string; // HTML content
    toRecipients: Array<{ email: string; name?: string }>;
    ccRecipients?: Array<{ email: string; name?: string }>;
    bccRecipients?: Array<{ email: string; name?: string }>;
    attachments?: EmailAttachment[];
    importance?: "low" | "normal" | "high";
    saveToSentItems?: boolean;
    fromMailbox?: string; // Optional: specific shared mailbox to send from
    headers?: Record<string, string>;
}

/**
 * Build the JSON body for /users/{mailbox}/sendMail. Shared by sendEmail (single)
 * and sendEmailBatch ($batch). Both call sites need an identical payload shape;
 * extracting this avoids drift between the two paths.
 */
function buildSendMailPayload(message: EmailMessage): {
    payload: Record<string, unknown>;
    sharedMailbox: string;
} {
    const sharedMailbox = message.fromMailbox || process.env.SHARED_MAILBOX_ADDRESS;
    if (!sharedMailbox) {
        throw new Error("No mailbox specified and SHARED_MAILBOX_ADDRESS is not configured");
    }

    // A single recipient's `email` may itself contain several addresses separated
    // by commas or semicolons (e.g. a free-text CC field where the user typed
    // multiple addresses). Graph requires one address per recipient object, so
    // expand them here — otherwise the whole joined string is treated as one
    // unresolvable mailbox and the send fails with ErrorInvalidRecipients.
    const toGraphRecipients = (recipients: Array<{ email: string; name?: string }>) =>
        recipients.flatMap((r) =>
            r.email
                .split(/[,;]/)
                .map((addr) => addr.trim())
                .filter((addr) => addr.length > 0)
                .map((address) => ({
                    emailAddress: { address, name: r.name || address },
                }))
        );

    const messageObj: Record<string, unknown> = {
        subject: message.subject,
        body: { contentType: "HTML", content: message.body },
        toRecipients: toGraphRecipients(message.toRecipients),
        importance: message.importance || "normal",
    };

    if (message.headers) {
        messageObj.internetMessageHeaders = Object.entries(message.headers).map(
            ([name, value]) => ({ name, value })
        );
    }

    if (message.ccRecipients && message.ccRecipients.length > 0) {
        const cc = toGraphRecipients(message.ccRecipients);
        if (cc.length > 0) messageObj.ccRecipients = cc;
    }

    if (message.bccRecipients && message.bccRecipients.length > 0) {
        const bcc = toGraphRecipients(message.bccRecipients);
        if (bcc.length > 0) messageObj.bccRecipients = bcc;
    }

    if (message.attachments && message.attachments.length > 0) {
        messageObj.attachments = message.attachments.map((att) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: att.name,
            contentType: att.contentType,
            contentBytes: att.contentBase64,
            isInline: att.isInline !== undefined ? att.isInline : att.contentType.startsWith("image/"),
            contentId: att.contentId || att.name.replace(/\.[^.]+$/, ""),
        }));
    }

    return {
        payload: { message: messageObj, saveToSentItems: message.saveToSentItems !== false },
        sharedMailbox,
    };
}

/**
 * Send an email using Microsoft Graph API from a shared mailbox
 * @param message - Email message with optional fromMailbox override
 */
export async function sendEmail(message: EmailMessage): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const { payload: emailPayload, sharedMailbox } = buildSendMailPayload(message);
    const token = await getGraphAccessToken();

    // Send email from shared mailbox with retries for transient failures
    const url = `https://graph.microsoft.com/v1.0/users/${sharedMailbox}/sendMail`;
    const maxAttempts = 3;
    const baseDelayMs = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(emailPayload),
        });

        if (response.ok) {
            return { success: true };
        }

        const errorText = await response.text();

        // Don't retry on client errors (4xx except 429)
        if (!isRetryableHttpStatus(response.status)) {
            console.error("Graph API error:", response.status, errorText);
            return {
                success: false,
                error: `Failed to send email: ${response.status} - ${errorText}`,
            };
        }

        if (attempt === maxAttempts) {
            console.error("Graph API error (max retries):", response.status, errorText);
            return {
                success: false,
                error: `Failed to send email after ${maxAttempts} attempts: ${response.status} - ${errorText}`,
            };
        }

        // For 429 (rate limit / IncomingBytes), use Retry-After or minimum 90s delay.
        // IncomingBytes limit resets over a 5-min window; short backoff is insufficient.
        let delayMs: number;
        if (response.status === 429) {
            const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
            delayMs = Math.max((retryAfterSeconds ?? 90) * 1000, 90_000);
        } else {
            delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return { success: true };
}

export interface BatchSendResult {
    success: boolean;
    error?: string;
    status?: number;
}

function formatBatchErrorBody(body: unknown): string {
    if (body === null || body === undefined) return "";
    if (typeof body === "string") return body.slice(0, 300);
    try {
        return JSON.stringify(body).slice(0, 300);
    } catch {
        return String(body).slice(0, 300);
    }
}

/**
 * Send up to 20 emails in a single Microsoft Graph $batch HTTP call.
 * Returns per-message results in the same order as the input.
 *
 * Important behaviour notes (from Graph throttling docs):
 *  - The outer $batch HTTP call returns 200 even when sub-items fail. Each
 *    sub-response carries its own status / headers / body.
 *  - Microsoft Graph forwards at most 4 sub-requests at a time to Outlook,
 *    regardless of batch size. A batch of 20 effectively executes as 5 groups
 *    of 4 in parallel on the Outlook side.
 *  - At-most-once (PRD #55, issue #57): a non-2xx *sub-response* is TERMINAL —
 *    that recipient settles `failed` with no in-call resend. Such a response
 *    may arrive after the message was already accepted and delivered, so
 *    resending it is what produced the reported 6× duplicate. The only retry
 *    is the outer envelope: a rejected $batch POST (before any sub-request runs)
 *    delivered nothing, so retrying the whole envelope is safe.
 */
export async function sendEmailBatch(
    messages: EmailMessage[]
): Promise<BatchSendResult[]> {
    if (messages.length === 0) return [];
    if (messages.length > 20) {
        throw new Error("Microsoft Graph $batch supports at most 20 sub-requests");
    }

    // Pre-build sub-request bodies once. Reuse across outer-envelope retries so
    // we don't rebuild large attachment payloads.
    const subRequests = messages.map((message, idx) => {
        const { payload, sharedMailbox } = buildSendMailPayload(message);
        return {
            id: String(idx),
            method: "POST" as const,
            url: `/users/${sharedMailbox}/sendMail`,
            headers: { "Content-Type": "application/json" },
            body: payload,
        };
    });

    const maxAttempts = 3;
    const baseDelayMs = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const token = await getGraphAccessToken();

        const batchResponse = await fetch("https://graph.microsoft.com/v1.0/$batch", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ requests: subRequests }),
        });

        // Outer $batch HTTP failure (rare — usually only on auth or network).
        // Nothing was forwarded to Outlook, so retrying the whole envelope is
        // safe. This is the ONLY retry.
        if (!batchResponse.ok) {
            const errText = await batchResponse.text();
            console.error(`$batch HTTP ${batchResponse.status}: ${errText}`);

            const isLastAttempt = attempt === maxAttempts;
            if (isLastAttempt || !isRetryableHttpStatus(batchResponse.status)) {
                return messages.map(() => ({
                    success: false,
                    status: batchResponse.status,
                    error: `$batch failed: ${batchResponse.status} - ${errText.slice(0, 300)}`,
                }));
            }

            const retryAfterSec =
                batchResponse.status === 429
                    ? parseRetryAfter(batchResponse.headers.get("Retry-After"))
                    : null;
            const delayMs =
                batchResponse.status === 429
                    ? Math.max((retryAfterSec ?? 90) * 1000, 90_000)
                    : baseDelayMs * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
        }

        const responseBody = (await batchResponse.json()) as {
            responses: Array<{
                id: string;
                status: number;
                headers?: Record<string, string>;
                body?: unknown;
            }>;
        };

        // The outer POST was accepted, so every sub-request reached Outlook.
        // Settle each sub-response terminally — 2xx succeeds, anything else
        // fails with no resend (at-most-once, issue #57).
        const results: BatchSendResult[] = new Array(messages.length);
        for (const sub of responseBody.responses) {
            const idx = parseInt(sub.id, 10);
            if (Number.isNaN(idx) || idx < 0 || idx >= messages.length) continue;

            // sendMail returns 202 Accepted on success.
            if (sub.status >= 200 && sub.status < 300) {
                results[idx] = { success: true, status: sub.status };
            } else {
                results[idx] = {
                    success: false,
                    status: sub.status,
                    error: `${sub.status} - ${formatBatchErrorBody(sub.body)}`,
                };
            }
        }

        // Defensive: a sub-request the batch omitted from its responses is a
        // bug on Graph's side; settle it failed rather than leaving a hole.
        for (let idx = 0; idx < messages.length; idx++) {
            if (!results[idx]) {
                results[idx] = {
                    success: false,
                    error: "No sub-response returned for this recipient",
                };
            }
        }

        return results;
    }

    // Unreachable: the loop above either returns or exhausts outer-envelope
    // retries (which returns on the last attempt). Kept for exhaustiveness.
    return messages.map(() => ({
        success: false,
        error: "Unknown failure (exhausted retries with no response)",
    }));
}

/**
 * Upload an inline image and get its content ID for embedding in HTML
 */
export function createInlineImageHtml(imageName: string, altText: string): string {
    const contentId = imageName.replace(/\.[^.]+$/, "");
    return `<img src="cid:${contentId}" alt="${altText}" style="max-width: 100%; height: auto;" />`;
}
