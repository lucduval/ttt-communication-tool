/**
 * Invoice-PDF generator client — the Azure-function boundary for the bad-debt
 * campaign (PRD `prd-bad-debt-excel-campaign.md`, issue #68).
 *
 * The function contract was confirmed by the #64 spike (function `ttt-invoice-gen`
 * / GUID-input variant `ttt-invoice-gen2`):
 *
 *   POST {base}?code={functionKey}
 *   body: { "invoiceId": "<new_invoicesid GUID>", "type": "Tax" | "Accounting"? }
 *   200 → Content-Type: application/pdf, raw PDF bytes (~65 KB)
 *   400 → missing/bad invoiceId
 *   500 → { error }
 *
 * The bottleneck is Dataverse service-protection limits, so a busy environment
 * answers with 429 + `Retry-After`; we honour it (and back off on other transient
 * statuses) exactly as {@link ./graph_client} does for Graph. Everything else is a
 * terminal failure returned to the caller — the pre-gen orchestrator records it so
 * the failed recipient is held by the validation gate (#67) rather than breaking a
 * live send.
 *
 * Like {@link ./graph_client}, this calls the global `fetch`, so tests drive it
 * with `vi.stubGlobal("fetch", …)` + fake timers (prior art `graph_client.test.ts`).
 */

import { isRetryableHttpStatus } from "./retry";

/** The confirmed invoice-type discriminator; omitted lets the function default it. */
export type InvoiceType = "Tax" | "Accounting";

export interface InvoicePdfConfig {
    /** The function endpoint up to the path, e.g. `https://…/api/invoice-generator`. */
    baseUrl: string;
    /** The Azure function key sent as the `?code=` query parameter. */
    functionKey: string;
}

/**
 * Read the invoice-PDF function config from the environment, mirroring
 * {@link ./whatsapp}'s `getMetaWhatsAppConfig`. Throws a clear, actionable error
 * naming every missing variable rather than failing deep inside a fetch.
 */
export function getInvoicePdfConfig(): InvoicePdfConfig {
    const baseUrl = process.env.INVOICE_GENERATOR_URL;
    const functionKey = process.env.INVOICE_GENERATOR_KEY;
    if (!baseUrl || !functionKey) {
        throw new Error(
            "Missing required environment variables for invoice PDF generation: " +
                "INVOICE_GENERATOR_URL, INVOICE_GENERATOR_KEY",
        );
    }
    return { baseUrl, functionKey };
}

export interface GenerateInvoicePdfArgs {
    /** The `new_invoicesid` GUID identifying the invoice to render. */
    invoiceId: string;
    /** Optional invoice-type discriminator; omitted lets the function default it. */
    type?: InvoiceType;
    /** Config override (tests / non-env callers); defaults to {@link getInvoicePdfConfig}. */
    config?: InvoicePdfConfig;
    /** Max attempts including the first (default 3), matching the Graph client. */
    maxAttempts?: number;
    /** Injectable sleep so backoff costs no real wall-clock under test. */
    sleep?: (ms: number) => Promise<void>;
}

export type GenerateInvoicePdfResult =
    | { success: true; bytes: ArrayBuffer; contentType: string }
    | { success: false; status?: number; error: string };

/**
 * Parse a `Retry-After` header (seconds or HTTP-date) into whole seconds, or null
 * when unparseable. Duplicated from {@link ./graph_client} deliberately — the two
 * clients back off against different services and should not couple.
 */
function parseRetryAfter(value: string | null): number | null {
    if (!value?.trim()) return null;
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
        return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
    }
    return null;
}

/**
 * Generate one invoice PDF by GUID. Returns the raw PDF bytes on success, or a
 * terminal failure (status + message) after exhausting retries. A 429 is retried
 * honouring `Retry-After`; other transient statuses (5xx) use exponential backoff;
 * 4xx (bad/missing invoiceId) is terminal with no retry.
 */
export async function generateInvoicePdf(
    args: GenerateInvoicePdfArgs,
): Promise<GenerateInvoicePdfResult> {
    const { invoiceId, type } = args;
    if (!invoiceId.trim()) {
        return { success: false, error: "invoiceId is required" };
    }

    const config = args.config ?? getInvoicePdfConfig();
    const maxAttempts = args.maxAttempts ?? 3;
    const baseDelayMs = 1000;
    const sleep =
        args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    const url = `${config.baseUrl}?code=${encodeURIComponent(config.functionKey)}`;
    const body = JSON.stringify(type ? { invoiceId, type } : { invoiceId });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });
        } catch (err) {
            // A network error delivered nothing; retry it like a transient status.
            if (attempt === maxAttempts) {
                return { success: false, error: `Invoice PDF request failed: ${String(err)}` };
            }
            await sleep(baseDelayMs * 2 ** (attempt - 1));
            continue;
        }

        if (response.ok) {
            const contentType = response.headers.get("Content-Type") ?? "application/pdf";
            const bytes = await response.arrayBuffer();
            return { success: true, bytes, contentType };
        }

        const errorText = await response.text().catch(() => "");

        // 4xx (except 429) is terminal — a bad/missing invoiceId won't fix itself.
        if (!isRetryableHttpStatus(response.status)) {
            return {
                success: false,
                status: response.status,
                error: `Invoice PDF generation failed: ${response.status} - ${errorText.slice(0, 300)}`,
            };
        }

        if (attempt === maxAttempts) {
            return {
                success: false,
                status: response.status,
                error: `Invoice PDF generation failed after ${maxAttempts} attempts: ${response.status} - ${errorText.slice(0, 300)}`,
            };
        }

        // 429 → honour Retry-After (the Dataverse service-protection signal);
        // other transient statuses → exponential backoff.
        let delayMs: number;
        if (response.status === 429) {
            const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
            delayMs = (retryAfterSeconds ?? 5) * 1000;
        } else {
            delayMs = baseDelayMs * 2 ** (attempt - 1);
        }
        await sleep(delayMs);
    }

    // Unreachable: the loop returns on the last attempt.
    return { success: false, error: "Invoice PDF generation failed: exhausted retries" };
}
