/**
 * Invoice-PDF pre-generation orchestrator — pure core (PRD
 * `prd-bad-debt-excel-campaign.md`, issue #68).
 *
 * Given the recipients that need a PDF, drive a **bounded-concurrency** run that,
 * per recipient, fetches the invoice PDF (the Azure boundary), stores its bytes in
 * Convex storage, and records the terminal per-recipient status. Generation happens
 * ahead of the send so a failure surfaces in the pre-send validation gate (#67) —
 * a `failed` status feeds `buildValidationReport`'s `missing-pdf` hold — rather than
 * breaking a live send.
 *
 * The whole thing is dependency-injected so it is testable with fakes, exactly like
 * {@link ./channelSend}'s driver: the Azure client and Convex storage are mocked, and
 * the test asserts the external behaviour at the seam — a `storageId` recorded per
 * generated recipient, a failure recorded per failed one, and **never more than
 * `concurrency` fetches in flight**. The bound matters: fanning out wider than
 * ~5–8 trips Dataverse service-protection throttling, which is the real bottleneck
 * (the function itself renders in ~25 ms), not the function.
 *
 * No Convex, no `fetch`, no timers here — the impure edges (the real client, real
 * `ctx.storage.store`, real mutation) are supplied by the action that composes this.
 */

import type { PdfStatus } from "../../src/components/recipients/validationReport";

export interface PregenItem {
    /** The recipient identity (tracking-key value) — the key the status is recorded under. */
    recipientId: string;
    /** The `new_invoicesid` GUID this recipient's PDF is generated from. */
    invoiceGuid: string;
    /** Optional invoice-type discriminator passed through to the generator. */
    type?: string;
}

/** The terminal outcome recorded for one recipient. */
export type PregenOutcome =
    | { recipientId: string; invoiceGuid: string; status: "generated"; storageId: string }
    | { recipientId: string; invoiceGuid: string; status: "failed"; error: string };

export interface PregenDeps {
    /**
     * Fetch one recipient's PDF bytes from the Azure function. Resolves to the raw
     * bytes on success; **throws** on a terminal failure (bad GUID, exhausted
     * retries) — the orchestrator catches it and records `failed`. Keeping the two
     * edges (`fetchPdf` and {@link store}) separate is what lets a test mock the
     * Azure client and Convex storage independently, per the issue's test plan.
     */
    fetchPdf: (item: PregenItem) => Promise<ArrayBuffer>;
    /** Store PDF bytes in Convex storage and return the `storageId` reference. */
    store: (bytes: ArrayBuffer, item: PregenItem) => Promise<string>;
    /** Persist one recipient's terminal PDF status (the only thing kept — never bytes). */
    record: (outcome: PregenOutcome) => Promise<void>;
    /**
     * Max concurrent {@link fetchPdf} calls in flight. Sized ~5–8 to stay under
     * Dataverse service-protection limits; values ≤0 are treated as 1.
     */
    concurrency: number;
}

export interface PregenSummary {
    total: number;
    generated: number;
    failed: number;
}

/**
 * Run one recipient end to end: fetch → store → record `generated`, or record
 * `failed` on any thrown error from either edge. Never throws — a single
 * recipient's failure must not abort the whole run; it is recorded and the gate
 * holds that row.
 */
async function runOne(item: PregenItem, deps: PregenDeps): Promise<PdfStatus> {
    try {
        const bytes = await deps.fetchPdf(item);
        const storageId = await deps.store(bytes, item);
        await deps.record({
            recipientId: item.recipientId,
            invoiceGuid: item.invoiceGuid,
            status: "generated",
            storageId,
        });
        return "generated";
    } catch (err) {
        await deps.record({
            recipientId: item.recipientId,
            invoiceGuid: item.invoiceGuid,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
        });
        return "failed";
    }
}

/**
 * Pre-generate PDFs for every item with **at most `concurrency`** generations in
 * flight, returning a summary of how many were generated vs failed. Implemented as
 * a fixed pool of workers draining a shared cursor — so the in-flight count is
 * bounded by construction regardless of how many items are passed.
 */
export async function pregenInvoicePdfs(
    items: readonly PregenItem[],
    deps: PregenDeps,
): Promise<PregenSummary> {
    const summary: PregenSummary = { total: items.length, generated: 0, failed: 0 };
    if (items.length === 0) return summary;

    const workers = Math.max(1, Math.min(deps.concurrency, items.length));
    let cursor = 0;

    const worker = async (): Promise<void> => {
        // Each worker pulls the next unclaimed item until the queue is drained.
        // A shared integer cursor gives every worker a distinct item with no locks
        // (single-threaded event loop: the read-then-increment is atomic).
        for (;;) {
            const index = cursor++;
            if (index >= items.length) return;
            const status = await runOne(items[index], deps);
            if (status === "generated") summary.generated++;
            else summary.failed++;
        }
    };

    await Promise.all(Array.from({ length: workers }, () => worker()));
    return summary;
}
