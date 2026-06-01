"use node";

/**
 * Fire-and-forget bridge to Tina (the WhatsApp bot at ttt-prod-bot).
 *
 * Whenever this app sends a WhatsApp template at a TTT client — a test send or
 * a campaign batch — Tina has no idea it happened. The client's reply to that
 * template then lands on the bot with no context, so Tina answers "how can I
 * help?" instead of acknowledging the template.
 *
 * After a successful Meta send we POST the template name, the substituted
 * variables, and Meta's wamid to the bot's HMAC-signed
 * `/webhook/outbound-notify`. The bot composes the seeded body text and writes
 * an `assistant`-role row into conversation history, keyed by the wamid so
 * retries are idempotent.
 *
 * Two principles drive the design (see outbound-notify-integration.md):
 *   1. The WhatsApp send is the load-bearing action. If notify fails the
 *      message still went out — losing context-seeding for one send is fine.
 *   2. Notify is best-effort, never blocking. It never throws; the caller
 *      awaits only so Convex doesn't tear the action down before fetch
 *      resolves.
 */

import { createHmac } from "node:crypto";

export interface NotifyTinaParams {
    /** Recipient phone in any SA format — bot normalises. */
    phone: string;
    /** Meta-approved template name. */
    templateName: string;
    /** Defaults to "en". */
    templateLanguage?: string;
    /**
     * Variables substituted into {{1}}, {{2}}, … in the body, in order.
     * Pass the literal strings the client saw — these become the seeded
     * history that Tina reads on the next inbound.
     */
    templateVariables?: string[];
    /** Only relevant when the template's header is text with a {{1}} variable. */
    templateHeaderVariable?: string;
    /** Meta's wamid from the send response. Required for dedup on bot side. */
    senderMessageId: string;
    /** ISO 8601 timestamp; defaults to now. */
    sentAt?: string;
    /** Free-text tag for bot logs — e.g. "campaign_whatsapp", "manual_test". */
    sender?: string;
}

/**
 * Fire-and-forget POST to the bot's /webhook/outbound-notify so Tina records
 * the outbound template in conversation history. Failures are logged but
 * never thrown — the WhatsApp send has already happened, and the bot dedups
 * by sender_message_id so retries (manual or automatic) are safe.
 */
export async function notifyTinaOfOutboundTemplate(params: NotifyTinaParams): Promise<void> {
    const host = process.env.BOT_HOST;
    const secret = process.env.OUTBOUND_NOTIFY_SECRET;
    if (!host || !secret) {
        console.warn("[notifyTina] BOT_HOST or OUTBOUND_NOTIFY_SECRET not set — skipping");
        return;
    }

    // Stringify once: the same string is both HMAC-signed and POSTed.
    // Re-serialising would change byte order / spacing and break the signature.
    const body = JSON.stringify({
        phone: params.phone,
        template_name: params.templateName,
        template_language: params.templateLanguage ?? "en",
        template_variables: params.templateVariables ?? [],
        template_header_variable: params.templateHeaderVariable,
        sender_message_id: params.senderMessageId,
        sent_at: params.sentAt ?? new Date().toISOString(),
        sender: params.sender ?? "campaign_app",
    });

    const signature = createHmac("sha256", secret).update(body).digest("hex");

    try {
        const res = await fetch(`${host.replace(/\/$/, "")}/webhook/outbound-notify`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Outbound-Signature": signature,
            },
            body,
        });
        if (!res.ok) {
            console.warn(
                `[notifyTina] ${res.status} for ${params.templateName} → ${params.phone}: ${await res.text()}`
            );
        }
    } catch (e: any) {
        console.warn(
            `[notifyTina] fetch failed for ${params.templateName} → ${params.phone}: ${e?.message || e}`
        );
    }
}

/**
 * Resolve the ordered list of substituted body-variable strings for a notify
 * call. Mirrors `buildBodyParameters` in whatsapp.ts: the template's
 * `variables` array names the body placeholders in order, and `allVariables`
 * is the same merged map handed to the payload builder, so picking each name
 * out of the map yields exactly the literal strings the client saw.
 */
export function substitutedBodyVariables(
    variableNames: readonly string[],
    allVariables: Record<string, string>
): string[] {
    return variableNames.map((name) => allVariables[name] ?? "");
}
