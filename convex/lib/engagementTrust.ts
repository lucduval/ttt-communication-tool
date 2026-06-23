/**
 * Engagement Trust — the pure rule that decides whether a recipient's recorded
 * opens/clicks represent a *human* engaging, and therefore what opportunity
 * temperature they have actually earned.
 *
 * Why this exists: a logged click is NOT proof of human intent. Microsoft
 * Defender "Safe Links" and corporate mail gateways (Mimecast, Proofpoint, …)
 * pre-fetch every link in an email — server-side, before the recipient ever
 * sees the message — to scan it for malware. That fetch hits the `/click`
 * endpoint with an unbranded `Mozilla/5.0…` user-agent the substring denylist
 * in `tracking_utils.isBot` cannot catch, so it is logged as a real click. The
 * open pixel, meanwhile, is a remote image Outlook blocks by default, so it
 * often never fires. The result — a click with no corresponding open, frequently
 * landing within seconds of send — is the canonical signature of a scanner, not
 * a hot lead. Today that signature is escalated straight to HOT and a human
 * phones a prospect who never opened the email.
 *
 * This module owns the single corroboration rule that separates a trusted human
 * signal from a machine prefetch. It is pure — no Convex `ctx`, no DB, no clock
 * — and takes plain evidence so it can be unit-tested as a truth table and
 * reused by both the diagnostic (engagementAudit) and, once adopted, the intake
 * mutations (tracking.logClick / logOpen).
 *
 * Two scanner signatures it keys off:
 *   1. Uncorroborated click — a click with no open. A human who clicks almost
 *      always renders the email first (firing the pixel); a gateway fetches the
 *      link without ever loading the image.
 *   2. Prefetch-window hit — a click (or open) landing sooner after send than
 *      any human could plausibly act. Delivery-time link scanning fires here.
 */

/** What we know about one recipient's engagement with one campaign. */
export interface EngagementEvidence {
    hasOpen: boolean;
    hasClick: boolean;
    /** Earliest click minus the message's sentAt, in ms. Undefined if no click or no sentAt. */
    clickLatencyMs?: number;
    /** Earliest open minus the message's sentAt, in ms. Undefined if no open or no sentAt. */
    openLatencyMs?: number;
}

/** The knobs that define "human" — tune against the diagnostic's findings. */
export interface TrustPolicy {
    /** A hit landing sooner than this after send is treated as machine prefetch, not a human. */
    prefetchWindowMs: number;
    /** When true, a click only earns HOT if an open corroborates it (a human rendered the email). */
    requireOpenForClickTrust: boolean;
}

/**
 * Conservative defaults: a false HOT wastes a sales call (the reported pain),
 * while a missed HOT merely stays WARM and still gets worked — so corroboration
 * is required and the prefetch window is generous.
 */
export const DEFAULT_TRUST_POLICY: TrustPolicy = {
    prefetchWindowMs: 120_000, // 2 minutes
    requireOpenForClickTrust: true,
};

/** Symbolic verdict; the caller maps this onto OPPORTUNITY_TEMPERATURE. "none" = do not escalate. */
export type EngagementVerdict = "hot" | "warm" | "none";

export interface TrustResult {
    verdict: EngagementVerdict;
    trustedClick: boolean;
    trustedOpen: boolean;
    /** Clicked, but the evidence says scanner — the population the current rule mislabels HOT. */
    suspectClick: boolean;
    /** Human-readable why, for the diagnostic and for audit trails. */
    reasons: string[];
}

/** Decide the temperature a recipient's engagement has actually earned. */
export function assessEngagement(
    ev: EngagementEvidence,
    policy: TrustPolicy = DEFAULT_TRUST_POLICY
): TrustResult {
    const reasons: string[] = [];

    const clickPrefetch =
        ev.hasClick &&
        ev.clickLatencyMs !== undefined &&
        ev.clickLatencyMs < policy.prefetchWindowMs;
    const openPrefetch =
        ev.hasOpen &&
        ev.openLatencyMs !== undefined &&
        ev.openLatencyMs < policy.prefetchWindowMs;
    const uncorroboratedClick = ev.hasClick && !ev.hasOpen;

    if (clickPrefetch) reasons.push("click within prefetch window of send");
    if (uncorroboratedClick) reasons.push("click with no corresponding open");
    if (openPrefetch) reasons.push("open within prefetch window of send");

    const trustedOpen = ev.hasOpen && !openPrefetch;

    let trustedClick = ev.hasClick && !clickPrefetch;
    if (policy.requireOpenForClickTrust) {
        trustedClick = trustedClick && ev.hasOpen;
    }

    const suspectClick = ev.hasClick && !trustedClick;

    const verdict: EngagementVerdict = trustedClick
        ? "hot"
        : trustedOpen
          ? "warm"
          : "none";

    return { verdict, trustedClick, trustedOpen, suspectClick, reasons };
}
