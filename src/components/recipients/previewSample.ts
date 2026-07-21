/**
 * Pre-send preview sample — pure core (PRD `prd-bad-debt-excel-campaign.md`, issue #71,
 * user story #29).
 *
 * Let the operator sanity-check a campaign before committing to a send: render a handful
 * of the *validated* rows through the **real merge engine** so they see exactly what each
 * recipient will receive — the merged subject/body plus (via the invoice GUID) that
 * recipient's attached PDF.
 *
 * The load-bearing property is fidelity: this must draw from the same rows and the same
 * substitution path the real send uses, not a mock. So it consumes {@link MaterialisedRecipient}
 * straight from the validation report's `sendable` list (#67) — the exact set the send path
 * is allowed to send — and builds each recipient's merge context the same way the email
 * adapter does (`convex/channelSenders.ts`): the built-in tokens (`firstName`, `fullName`,
 * `email`) layered *under* the row's cell bag, so a row column overrides a built-in on a
 * header collision, then runs it through {@link applyMerge} — the one true engine (#66).
 *
 * The upload path carries no display name, so `firstName`/`fullName` render empty; `email`
 * is the designated send-address cell. The unresolved-placeholder contract of `applyMerge`
 * holds here too: a `{column}` the row lacks renders as an empty string, never a raw
 * `{placeholder}` (the validation gate holds such rows upstream anyway).
 *
 * Pure — no React, no Convex, no network — so the merge fidelity is provable in isolation.
 * The impure edge (generating each sample recipient's PDF on demand from the same Azure
 * boundary the send uses) lives in the action that composes this; the preview only names
 * the `invoiceGuid` to generate from.
 */

import { applyMerge } from "../../../convex/lib/applyMerge";
import type { MaterialisedRecipient } from "./columnRoles";

/** One rendered sample message — a true picture of what this recipient would receive. */
export interface PreviewMessage {
    /** The recipient's identity (tracking-key value). */
    recipientId: string;
    /** The send-address cell, or null when no send-address role is designated. */
    sendAddress: string | null;
    /** The subject rendered through the real merge engine. */
    subject: string;
    /** The body rendered through the real merge engine. */
    body: string;
    /** The invoice-GUID cell the attached PDF is generated from, or null when none. */
    invoiceGuid: string | null;
    /** The row's raw cell bag (`{ header: cell }`), so the operator can eyeball each value. */
    mergedValues: Record<string, string>;
}

/**
 * Build the merge context for one recipient exactly as the email adapter does: the built-in
 * tokens first, then the row bag spread over them so a row column named e.g. `email` wins on
 * collision. The upload path has no name, so `firstName`/`fullName` are empty; `email` is the
 * send-address cell (empty when unassigned).
 */
export function buildMergeContext(recipient: MaterialisedRecipient): Record<string, string> {
    return {
        firstName: "",
        fullName: "",
        email: recipient.sendAddress ?? "",
        ...recipient.variables,
    };
}

/**
 * Render up to `limit` of the validated `recipients` (in order) into preview messages, each
 * with its merged subject/body and the invoice GUID its attached PDF comes from. A
 * non-positive `limit` yields an empty sample.
 */
export function buildPreviewMessages(
    subject: string,
    body: string,
    recipients: readonly MaterialisedRecipient[],
    limit: number,
): PreviewMessage[] {
    if (limit <= 0) return [];
    return recipients.slice(0, limit).map((recipient) => {
        const context = buildMergeContext(recipient);
        return {
            recipientId: recipient.recipientId,
            sendAddress: recipient.sendAddress,
            subject: applyMerge(subject, context),
            body: applyMerge(body, context),
            invoiceGuid: recipient.invoiceGuid,
            mergedValues: recipient.variables,
        };
    });
}
