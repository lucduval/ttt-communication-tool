/**
 * Campaign Tally — the pure rule that turns a campaign's per-recipient message
 * statuses into the canonical delivery counts (PRD #44, slice #45).
 *
 * The `messages` table is the source of truth: each recipient's status is
 * written idempotently. This module is the single seam that owns the count
 * definitions, so every reader that crosses it produces identical numbers and
 * cannot diverge. It is pure — no Convex `ctx`, no DB access — and takes a
 * plain collection of statuses so it can be unit-tested as a truth table and
 * reused by later slices (#46's `recomputeCampaignStats`, #47's backfill).
 *
 * Definitions:
 *   sent      – "sent" plus "delivered" (successfully handed to the provider)
 *   delivered – "delivered" only (confirmed delivery)
 *   failed    – "failed" (send error or bounce)
 *   pending   – "pending" (not yet attempted) plus "attempted" (handed to the
 *               provider but not yet settled to sent/delivered/failed) — an
 *               in-flight recipient counts as pending, never as sent/failed.
 *
 * Statuses outside these buckets (e.g. engagement states like "opened") are
 * ignored — they contribute to no count.
 */
export interface CampaignTally {
    sent: number;
    delivered: number;
    failed: number;
    pending: number;
}

/** Fold a campaign's message statuses into the canonical delivery counts. */
export function tallyCampaign(statuses: Iterable<string>): CampaignTally {
    let sent = 0;
    let delivered = 0;
    let failed = 0;
    let pending = 0;

    for (const status of statuses) {
        switch (status) {
            case "sent":
                sent++;
                break;
            case "delivered":
                delivered++;
                break;
            case "failed":
                failed++;
                break;
            case "pending":
            case "attempted":
                // "attempted" is in-flight (handed to the provider, outcome not
                // yet settled), so it counts as pending — never as sent/failed.
                pending++;
                break;
            // Unknown statuses are deliberately dropped — they belong to no bucket.
        }
    }

    return { sent: sent + delivered, delivered, failed, pending };
}
