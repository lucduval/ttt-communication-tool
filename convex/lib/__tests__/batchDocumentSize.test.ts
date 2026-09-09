/**
 * Regression for the failure that rejected bad-debt run 9's WhatsApp send:
 *
 *   Uncaught Error: Value is too large (1.21 MiB > maximum size 1 MiB)
 *     at handler (../../convex/campaignBatches.ts:107)
 *
 * `WHATSAPP_BATCH_SIZE = 1000` put all 937 recipients of `wa__paid_before.csv` into a
 * single `campaignBatches` document. Each recipient of an uploaded list carries the whole
 * CSV row in `variables` — 41 columns, ~1.5 KB each — so the document was 1.21 MiB against
 * Convex's 1 MiB ceiling. The count cap could not see that coming; nothing about 1000
 * recipients is wrong until you know how wide a recipient is.
 */
import { describe, it, expect } from "vitest";
import {
    chunkByPayload,
    jsonByteSize,
    MAX_BATCH_DOCUMENT_BYTES,
} from "../batchChunker";
import { WHATSAPP_BATCH_SIZE, EMAIL_BATCH_SIZE } from "../../campaignBatches";

const CONVEX_DOCUMENT_LIMIT = 1024 * 1024;

/** A recipient shaped like a real bad-debt upload row: 41 columns in `variables`. */
function badDebtRecipient(i: number) {
    const row: Record<string, string> = {};
    for (const col of [
        "Contact ID", "first_name", "full_name", "years_a_client", "invoice_number",
        "invoice_issue_date", "amount_formatted", "payment_link", "email", "mobile",
        "whatsapp_optin", "amount", "payment_token", "invoice_age_days", "bad_debt_band",
        "in_30d_to_3yr_window", "has_paid_before", "paid_invoices_count", "consultant",
        "consultant_email", "consultant_disabled", "contact_id", "invoice_id", "bad_debt_id",
        "cohort", "run1_emailed", "run1_bounced", "send_channel", "cadence_step",
        "wa_template_meta_id", "run2_channels", "run2_email_failed", "run3_segment",
        "run4_sent", "run5_cohort", "run6_cohort", "run7_cohort", "run8_cohort",
        "run9_cohort", "invoices_in_scope", "owed_in_scope",
    ]) {
        row[col] = `${col}-value-${i}`;
    }
    row["payment_link"] = `https://payment-link-ttt.azurewebsites.net/p/${"t".repeat(43)}`;
    return {
        id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        name: "",
        email: `client${i}@example.co.za`,
        phone: `2782${String(i).padStart(7, "0")}`,
        variables: JSON.stringify(row),
    };
}

const plan = (recipients: ReturnType<typeof badDebtRecipient>[], maxCount: number) =>
    chunkByPayload(recipients, jsonByteSize, {
        maxCount,
        maxBytes: MAX_BATCH_DOCUMENT_BYTES,
    });

describe("campaignBatches document sizing", () => {
    it("a run-9-sized WhatsApp upload is one oversized document under the count cap alone", () => {
        // What the old code did: slice(0, WHATSAPP_BATCH_SIZE).
        const all = Array.from({ length: 937 }, (_, i) => badDebtRecipient(i));
        expect(all.length).toBeLessThan(WHATSAPP_BATCH_SIZE);
        expect(jsonByteSize(all)).toBeGreaterThan(CONVEX_DOCUMENT_LIMIT);
    });

    it("splits that same upload into documents that all fit", () => {
        const all = Array.from({ length: 937 }, (_, i) => badDebtRecipient(i));
        const chunks = plan(all, WHATSAPP_BATCH_SIZE);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(jsonByteSize(chunk)).toBeLessThan(CONVEX_DOCUMENT_LIMIT);
        }
    });

    it("loses nobody and preserves order", () => {
        const all = Array.from({ length: 937 }, (_, i) => badDebtRecipient(i));
        const flat = plan(all, WHATSAPP_BATCH_SIZE).flat();
        expect(flat).toHaveLength(all.length);
        expect(flat.map((r) => r.id)).toEqual(all.map((r) => r.id));
    });

    it("holds for a far larger list than run 9", () => {
        const all = Array.from({ length: 5000 }, (_, i) => badDebtRecipient(i));
        for (const chunk of plan(all, WHATSAPP_BATCH_SIZE)) {
            expect(jsonByteSize(chunk)).toBeLessThan(CONVEX_DOCUMENT_LIMIT);
        }
    });

    it("still honours the channel count cap when rows are small", () => {
        const tiny = Array.from({ length: 500 }, (_, i) => ({
            id: `id-${i}`, name: "n", email: "a@b.co", phone: "27820000000", variables: "{}",
        }));
        for (const chunk of chunkByPayload(tiny, jsonByteSize, {
            maxCount: EMAIL_BATCH_SIZE,
            maxBytes: MAX_BATCH_DOCUMENT_BYTES,
        })) {
            expect(chunk.length).toBeLessThanOrEqual(EMAIL_BATCH_SIZE);
        }
    });
});
