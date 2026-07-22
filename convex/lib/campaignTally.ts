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
 *   delivered – sent minus bounces. Microsoft Graph cannot confirm true
 *               delivery for external recipients (delivery receipts are opt-in
 *               and most recipient orgs suppress them — see Microsoft KB
 *               3184617), so we adopt the ESP-standard definition: a message is
 *               "delivered" if it was handed to the provider and no bounce/NDR
 *               came back. A bounce flips the message's status "sent" → "failed"
 *               (see bounces.recordBouncesImpl), so the "sent"+"delivered"
 *               buckets already exclude bounces — delivered equals that count.
 *   failed    – "failed" (send error or bounce)
 *   pending   – "pending" (not yet attempted) plus "attempted" (handed to the
 *               provider but not yet settled to sent/delivered/failed) — an
 *               in-flight recipient counts as pending, never as sent/failed.
 *
 * Because there is no post-handoff delivery signal distinct from bounces, the
 * `sent` and `delivered` counts are necessarily equal; both are surfaced so
 * callers keep a stable shape.
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

    // A bounce demotes "sent" → "failed", so the success buckets already net
    // out bounces. delivered = sent − bounces collapses to the same count.
    const succeeded = sent + delivered;
    return { sent: succeeded, delivered: succeeded, failed, pending };
}
