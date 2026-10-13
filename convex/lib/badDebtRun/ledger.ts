/**
 * How many bad-debt messages each record has had, and the write-back of those
 * numbers to `riivo_baddebt` (`comms13.py` + `run7/plan_update.py`).
 *
 * Every rule is monotonic so a re-run can never undo an earlier one: the count only
 * rises, first-sent only moves earlier, last-sent and last-reply only move later,
 * bounced never clears. Run 7's write-back used these rules; a non-monotonic draft
 * would have erased run 1's history.
 */

export interface LedgerEntry {
    badDebtId: string;
    n: number;
    first?: string;
    last?: string;
    bounced: boolean;
    fails: number;
}

export interface SentMessage {
    /** The campaign's tracking key: the contact id. */
    recipientId: string;
    status: string;
    channel: "email" | "whatsapp";
    recipientEmail?: string;
    /** ISO time the message was created. */
    at: string;
}

const SENT = new Set(["sent", "delivered", "read"]);
/** Still in flight. Neither a send nor a failure yet; fold it on a later run. */
export const UNSETTLED = new Set(["pending", "attempted"]);

export interface FoldResult {
    entries: Map<string, LedgerEntry>;
    bounces: { contactId: string; address: string }[];
    unmatched: number;
}

/**
 * Fold one finished campaign's messages into the ledger. `badDebtByContact` maps the
 * campaign's tracking key back to the bad-debt record that row was built from.
 */
export function foldCampaign(
    ledger: ReadonlyMap<string, LedgerEntry>,
    messages: readonly SentMessage[],
    badDebtByContact: ReadonlyMap<string, string>,
): FoldResult {
    const entries = new Map<string, LedgerEntry>();
    const get = (id: string) => {
        const have = entries.get(id) ?? ledger.get(id);
        const e = have ? { ...have } : { badDebtId: id, n: 0, bounced: false, fails: 0 };
        entries.set(id, e);
        return e;
    };
    const bounces: FoldResult["bounces"] = [];
    let unmatched = 0;
    for (const m of messages) {
        if (UNSETTLED.has(m.status)) continue;
        const bd = badDebtByContact.get(m.recipientId.toLowerCase());
        if (!bd) { unmatched++; continue; }
        const e = get(bd);
        if (SENT.has(m.status)) {
            e.n += 1;
            if (!e.first || m.at < e.first) e.first = m.at;
            if (!e.last || m.at > e.last) e.last = m.at;
        } else {
            e.fails += 1;
            if (m.channel === "email") {
                e.bounced = true;
                const address = (m.recipientEmail ?? "").trim().toLowerCase();
                if (address) bounces.push({ contactId: m.recipientId.toLowerCase(), address });
            }
        }
    }
    return { entries, bounces, unmatched };
}

export interface CrmBadDebt {
    riivo_baddebtid: string;
    riivo_campaignsendcount?: number | null;
    riivo_campaignfirstsent?: string | null;
    riivo_campaignlastsent?: string | null;
    riivo_campaignlastreply?: string | null;
    riivo_campaignbounced?: boolean | null;
    riivo_baselineoutstanding?: number | null;
    riivo_outstandingamount?: number | null;
}

export interface WriteBackPatch {
    id: string;
    fields: Record<string, string | number | boolean>;
}

const d19 = (s: string | null | undefined) => (s ?? "").slice(0, 19);

/** The PATCHes that bring `riivo_baddebt` up to the ledger, never backwards. */
export function writeBackPlan(
    ledger: Iterable<LedgerEntry>,
    crm: ReadonlyMap<string, CrmBadDebt>,
    lastReplyByBadDebt: ReadonlyMap<string, string>,
): WriteBackPatch[] {
    const plan: WriteBackPatch[] = [];
    for (const v of ledger) {
        const r = crm.get(v.badDebtId);
        if (!r) continue;
        const want: WriteBackPatch["fields"] = {};
        const cur = r.riivo_campaignsendcount;
        const n = cur != null ? Math.max(v.n, cur) : v.n;
        if (n !== cur) want.riivo_campaignsendcount = n;
        const cf = d19(r.riivo_campaignfirstsent), nf = d19(v.first);
        if (nf && (!cf || nf < cf)) want.riivo_campaignfirstsent = nf + "Z";
        const cl = d19(r.riivo_campaignlastsent), nl = d19(v.last);
        if (nl && (!cl || nl > cl)) want.riivo_campaignlastsent = nl + "Z";
        const cr = d19(r.riivo_campaignlastreply), nr = d19(lastReplyByBadDebt.get(v.badDebtId));
        if (nr && (!cr || nr > cr)) want.riivo_campaignlastreply = nr + "Z";
        if (v.bounced && !r.riivo_campaignbounced) want.riivo_campaignbounced = true;
        if (r.riivo_baselineoutstanding == null && r.riivo_outstandingamount != null) {
            want.riivo_baselineoutstanding = r.riivo_outstandingamount;
        }
        if (Object.keys(want).length) plan.push({ id: v.badDebtId, fields: want });
    }
    return plan;
}
