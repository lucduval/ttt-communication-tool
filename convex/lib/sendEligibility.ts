/**
 * Send-path eligibility rule — the core of the at-most-once idempotency seam
 * (PRD #55, slice #56).
 *
 * A recipient is eligible to send iff it has NO `messages` row for the campaign,
 * in ANY status. A row in any state — the new `attempted` marker, a clean
 * `sent`/`delivered`, or a terminal `failed` — means "already handled: skip".
 * This replaces the old sent/delivered-only guard, which re-sent a `failed`
 * recipient on a stuck-batch recovery re-run and was the source of the reported
 * duplicate sends. Automatic sending therefore never resends a handled
 * recipient; recovering a genuine `failed` is a separate, explicit
 * operator-initiated path (issue #60).
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
 * Given the campaign's existing `messages` rows (any status) and a batch's
 * recipient list, return the recipients eligible to send: those with no
 * existing row. Status is deliberately not consulted — a row in *any* state
 * means already-handled, which is exactly what makes automatic sending
 * at-most-once. Rows for recipients outside the batch are ignored.
 */
export function eligibleRecipients<R extends { id: string }>(
    existingRows: Iterable<ExistingMessage>,
    batchRecipients: readonly R[]
): R[] {
    const handled = new Set<string>();
    for (const row of existingRows) handled.add(row.recipientId);
    return batchRecipients.filter((r) => !handled.has(r.id));
}
