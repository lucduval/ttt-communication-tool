/**
 * Send-path eligibility rule — the core of the at-most-once idempotency seam
 * (PRD #55, slice #56).
 *
 * A recipient is eligible to send iff it has NO `messages` row for the campaign
 * OR its only row is still `pending`. A row in any *settled* state — the
 * `attempted` marker, a clean `sent`/`delivered`, or a terminal `failed` —
 * means "already handled: skip". A `pending` row does NOT block: it is the seed
 * `createBatches` writes for every recipient up front (PRD #55 / #63), meaning
 * "created but never handed to a provider", so it must stay eligible or a fresh
 * campaign would send zero. The `attempted` marker (#58) — written immediately
 * before the Graph call — is what advances a recipient out of eligibility the
 * instant it is handed to Graph, so a `pending` row provably means "never sent"
 * and is never a recovery-resend hole.
 *
 * This keeps #56's headline fix — a terminal `failed` is no longer re-sent on a
 * stuck-batch recovery re-run, which was the source of the reported duplicate
 * sends — while reconciling with the pre-created `pending` rows the seam's model
 * had assumed away. Automatic sending never resends a *handled* recipient;
 * recovering a genuine `failed` is a separate, explicit operator-initiated path
 * (issue #60).
 *
 * Pure — no Convex `ctx`, no DB access — so no-duplicate behaviour is provable
 * as a truth table without a live mailbox. The Channel Send driver runs the
 * query and applies this rule once at batch start; the email adapter consumes
 * the resulting eligible set.
 */

/**
 * The recognised values of the free-form `messages.status` string. `status` is
 * `v.string()` in the schema, so this is a documentation/typing aid, not a
 * migration: `attempted` is additive — the durable "handed to Graph, outcome
 * unknown" marker the email path previously lacked. Distinct from `failed` (we
 * know it did not go) and `sent` (a clean success).
 */
export const MESSAGE_STATUSES = [
    "pending",
    "attempted",
    "sent",
    "delivered",
    "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Minimal shape of an existing campaign `messages` row the rule reasons about. */
export type ExistingMessage = {
    recipientId: string;
    /** Free-form in the DB; any value counts as "handled". */
    status: string;
};

/**
 * Given the campaign's existing `messages` rows and a batch's recipient list,
 * return the recipients eligible to send: those with no existing row, or a row
 * still in `pending`. Only a `pending` row is treated as not-yet-handled — the
 * seed `createBatches` writes for every recipient before the driver runs (PRD
 * #55 / #63); every other status (`attempted`/`sent`/`delivered`/`failed`, or
 * any unknown/future value) means already-handled, which is what makes
 * automatic sending at-most-once. Rows for recipients outside the batch are
 * ignored.
 */
export function eligibleRecipients<R extends { id: string }>(
    existingRows: Iterable<ExistingMessage>,
    batchRecipients: readonly R[]
): R[] {
    const handled = new Set<string>();
    for (const row of existingRows) {
        // `pending` = created (by createBatches) but never handed to a provider,
        // so it stays eligible; the `attempted` marker (#58) is what advances a
        // recipient out of eligibility once it is actually handed to Graph.
        if (row.status !== "pending") handled.add(row.recipientId);
    }
    return batchRecipients.filter((r) => !handled.has(r.id));
}
