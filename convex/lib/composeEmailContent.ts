/**
 * Email content composition — pure core (PRD `prd-bad-debt-excel-campaign.md`, PRD #74, issue #75).
 *
 * The single, load-bearing source of truth for the compliance rule and layout of a
 * standard email's inner HTML (everything that goes *inside* `wrapEmail`, before the
 * document shell). Both the real send path (`convex/channelSenders.ts`) and the
 * pre-send sample preview (`src/components/recipients/previewSample.ts`) render through
 * this one function, so preview↔send fidelity holds by construction rather than by
 * convention.
 *
 * It owns two things and nothing else:
 *
 *  1. The compliance rule — whether the unsubscribe footer is emitted:
 *     - **Utility** (transactional) sends omit the unsubscribe footer *even when* an
 *       unsubscribe URL is supplied, because the recipient has no opt-out from a
 *       transactional communication (e.g. a bad-debt payment reminder).
 *     - **Marketing** (and unset — treated as Marketing so existing/untouched
 *       campaigns keep today's behaviour) appends the footer when an unsubscribe URL
 *       is present, and omits it when none is configured — exactly as before.
 *
 *  2. The append order — `body → disclaimer → unsubscribe footer`.
 *
 * Pure: no Convex, no network, no React — so the compliance and layout decision is
 * provable in isolation. The merge engine (`applyMerge`) still runs over `body` and
 * (in the disclaimer-attach slice) the disclaimer *before* they reach this function;
 * this core only assembles the already-merged fragments.
 */

/** Whether a campaign is a marketing solicitation (unsubscribe-eligible) or a utility/transactional send. */
export type EmailType = "marketing" | "utility";

export interface ComposeEmailContentArgs {
    /** The merged inner HTML body of the email. */
    body: string;
    /** The campaign's email type. Unset is treated as Marketing (safe default). */
    emailType?: EmailType;
    /** The recipient's unsubscribe URL. Empty/absent means no URL is configured. */
    unsubscribeUrl?: string;
    /**
     * The merged disclaimer HTML to append above the unsubscribe footer. Always empty
     * in the email-type slice (#75); populated by the disclaimer-attach slice.
     */
    disclaimerHtml?: string;
}

/**
 * Generate an HTML unsubscribe footer for marketing email compliance. Exported so the
 * exact wording lives in one place (the send path used to own an identical copy).
 */
export function getUnsubscribeFooter(unsubscribeUrl: string): string {
    return `
    <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #718096; font-family: Arial, Helvetica, sans-serif;">
        <p style="margin: 4px 0;">You are receiving this email because you are a client of TTT.</p>
        <p style="margin: 4px 0;">
            If you no longer wish to receive these emails, you can
            <a href="${unsubscribeUrl}" style="color: #1a73e8; text-decoration: underline;">unsubscribe here</a>.
        </p>
    </div>`;
}

/**
 * Assemble the inner email HTML (pre-`wrapEmail`) from its already-merged fragments,
 * applying the compliance rule and the fixed append order `body → disclaimer →
 * unsubscribe footer`. See the module doc for the full contract.
 */
export function composeEmailContent({
    body,
    emailType,
    unsubscribeUrl,
    disclaimerHtml,
}: ComposeEmailContentArgs): string {
    // Utility suppresses the unsubscribe footer even where a URL exists; Marketing
    // (and unset, treated as Marketing) appends it only when a URL is configured.
    const includeUnsubscribe = emailType !== "utility" && !!unsubscribeUrl;

    return (
        body +
        (disclaimerHtml ?? "") +
        (includeUnsubscribe ? getUnsubscribeFooter(unsubscribeUrl!) : "")
    );
}
