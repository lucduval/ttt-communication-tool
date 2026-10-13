/**
 * Weekly bad-debt run — who is chased, on which invoice, through which channel.
 *
 * A straight port of the hand-built run pipeline (`.scratch/bad-debt-recovery/run13/`
 * `finalise13.py` + `enrich13.py` + `build_run13.py`), which built runs 10–13. The rules
 * are the operator decisions those runs recorded; changing one here changes who gets a
 * debt-collection message, so each carries the run that settled it.
 *
 * Pure: Dataverse rows in, run rows out. The action in `convex/actions/badDebtRun.ts`
 * does the fetching and the writing.
 */

export const AGE_FLOOR_DAYS = 30;
/** Over three years an invoice has prescribed and is no longer chased. */
export const AGE_CEILING_DAYS = 1095;
/** An invoice must owe MORE than this to be chased (R50 floor, run 8). */
export const AMOUNT_FLOOR = 50;
export const STATUS_PAID = 958140003;
/** Payment in flight. Chasing it is how the #105 complaint happens. */
export const STATUS_PENDING_SETTLEMENT = 463630002;
/** Runs 12+ split each channel at this age into a fresh-debt and an older-debt campaign. */
export const AGE_SPLIT_DAYS = 60;

export interface BadDebtRow {
    riivo_baddebtid: string;
    statecode: number;
    _riivo_invoice_value?: string | null;
    riivo_clientemail?: string | null;
    riivo_clientmobile?: string | null;
    riivo_clientfullname?: string | null;
    createdon?: string | null;
    riivo_campaignsendcount?: number | null;
    riivo_campaignfirstsent?: string | null;
    riivo_campaignlastsent?: string | null;
    riivo_campaignlastreply?: string | null;
    riivo_campaignbounced?: boolean | null;
    riivo_baselineoutstanding?: number | null;
    riivo_outstandingamount?: number | null;
}

export interface InvoiceRow {
    new_invoicesid: string;
    new_name?: string | null;
    ttt_invoiceid?: string | null;
    statecode: number;
    statuscode?: number | null;
    ttt_outstanding?: number | null;
    createdon: string;
    riivo_paymenttoken?: string | null;
    _ttt_customer_value?: string | null;
    _ownerid_value?: string | null;
}

export interface ContactRow {
    contactid: string;
    firstname?: string | null;
    fullname?: string | null;
    emailaddress1?: string | null;
    emailaddress2?: string | null;
    emailaddress3?: string | null;
    mobilephone?: string | null;
    icon_formattedmobilenumber?: string | null;
    telephone1?: string | null;
    riivo_whatsappoptinout?: boolean | null;
    donotemail?: boolean | null;
    donotbulkemail?: boolean | null;
    donotphone?: boolean | null;
    statecode?: number | null;
}

export interface SystemUserRow {
    systemuserid: string;
    fullname?: string | null;
    internalemailaddress?: string | null;
    isdisabled?: boolean | null;
}

/** One person the run will chase, before tokens and channels are resolved. */
export interface Chosen {
    contactId: string;
    badDebtId: string;
    invoiceId: string;
    amount: number;
    ageDays: number;
    email: string;
    name: string;
    messagesBefore: number;
    invoicesInScope: number;
    owedInScope: number;
}

export type ExclusionReason =
    | "too fresh (<30 days)"
    | "prescribed (>3 years)"
    | "no in-scope invoice"
    | "do-not-contact"
    | "reply hold"
    | "unreachable";

export interface Excluded {
    reason: ExclusionReason;
    people: number;
    value: number;
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** Whole days from the invoice's creation date to `today`, both taken as UTC dates. */
export function ageInDays(createdon: string, today: Date): number {
    const created = Date.UTC(
        Number(createdon.slice(0, 4)),
        Number(createdon.slice(5, 7)) - 1,
        Number(createdon.slice(8, 10)),
    );
    const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.round((t - created) / 86_400_000);
}

/** The contact's do-not-contact flags. Inactive contacts are still chased (run 8, still open). */
export function isDoNotContact(c: ContactRow | undefined): boolean {
    return !!(c && (c.donotemail || c.donotbulkemail || c.donotphone));
}

/** Email resolution order: the contact's three addresses, then the bad-debt record's copy. */
export function emailFor(c: ContactRow | undefined, bd: BadDebtRow): string {
    for (const v of [c?.emailaddress1, c?.emailaddress2, c?.emailaddress3, bd.riivo_clientemail]) {
        const s = (v ?? "").trim();
        if (s) return s;
    }
    return "";
}

export interface SelectInput {
    badDebts: readonly BadDebtRow[];
    /** Every invoice with statecode 0, read live. */
    openInvoices: readonly InvoiceRow[];
    contacts: ReadonlyMap<string, ContactRow>;
    /** Contact ids on the reply-hold list. */
    holds: ReadonlySet<string>;
    /** Messages each bad-debt record has had so far, keyed by lowercase bad-debt id. */
    messagesBefore: ReadonlyMap<string, number>;
    today: Date;
}

/**
 * One row per client: their NEWEST in-scope invoice (D10 — message, amount, PDF and
 * Pay-now token all agree on one invoice). Ties on age go to the larger amount.
 * Exclusions are checked in order and the first that fires wins, as in run 13.
 */
export function selectAudience(input: SelectInput): { chosen: Chosen[]; excluded: Excluded[] } {
    const invoices = new Map(input.openInvoices.map((i) => [lower(i.new_invoicesid), i]));
    type Cand = { bd: BadDebtRow; inv: InvoiceRow; amount: number; age: number };
    const byClient = new Map<string, Cand[]>();

    for (const bd of input.badDebts) {
        if (bd.statecode !== 0) continue;
        const inv = invoices.get(lower(bd._riivo_invoice_value));
        if (!inv) continue;
        const amount = inv.ttt_outstanding;
        if (amount == null || amount <= AMOUNT_FLOOR) continue;
        if (inv.statuscode === STATUS_PAID || inv.statuscode === STATUS_PENDING_SETTLEMENT) continue;
        // The client is the invoice's customer, not the bad-debt record's own lookup.
        const cust = lower(inv._ttt_customer_value);
        if (!cust) continue;
        const list = byClient.get(cust) ?? [];
        list.push({ bd, inv, amount, age: ageInDays(inv.createdon, input.today) });
        byClient.set(cust, list);
    }

    const excludedMap = new Map<ExclusionReason, Excluded>();
    const exclude = (reason: ExclusionReason, value: number) => {
        const e = excludedMap.get(reason) ?? { reason, people: 0, value: 0 };
        e.people += 1;
        e.value += value;
        excludedMap.set(reason, e);
    };

    const chosen: Chosen[] = [];
    for (const [cust, list] of byClient) {
        const inScope = list.filter((x) => x.age >= AGE_FLOOR_DAYS && x.age < AGE_CEILING_DAYS);
        if (inScope.length === 0) {
            const total = list.reduce((s, x) => s + x.amount, 0);
            if (list.every((x) => x.age < AGE_FLOOR_DAYS)) exclude("too fresh (<30 days)", total);
            else if (list.every((x) => x.age >= AGE_CEILING_DAYS)) exclude("prescribed (>3 years)", total);
            else exclude("no in-scope invoice", total);
            continue;
        }
        const c = inScope.reduce((best, x) =>
            x.age < best.age || (x.age === best.age && x.amount > best.amount) ? x : best,
        );
        const contact = input.contacts.get(cust);
        const email = emailFor(contact, c.bd);
        if (isDoNotContact(contact)) { exclude("do-not-contact", c.amount); continue; }
        if (input.holds.has(cust)) { exclude("reply hold", c.amount); continue; }
        if (!email && !(c.bd.riivo_clientmobile ?? "").trim()) { exclude("unreachable", c.amount); continue; }

        const badDebtId = lower(c.bd.riivo_baddebtid);
        chosen.push({
            contactId: cust,
            badDebtId,
            invoiceId: lower(c.inv.new_invoicesid),
            amount: c.amount,
            ageDays: c.age,
            email,
            name: (c.bd.riivo_clientfullname ?? contact?.fullname ?? "").trim(),
            messagesBefore: input.messagesBefore.get(badDebtId) ?? 0,
            invoicesInScope: inScope.length,
            owedInScope: round2(inScope.reduce((s, x) => s + x.amount, 0)),
        });
    }
    const excluded = [...excludedMap.values()].map((e) => ({ ...e, value: round2(e.value) }));
    return { chosen, excluded };
}

export function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** "R1,234.56" — the format every run's templates were approved and sent with. */
export function formatRand(n: number): string {
    return "R" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** E.164 digits for South Africa (27…), as Meta wants them; '' when unusable. */
export function normalisePhone(raw: string | null | undefined): string {
    const p = (raw ?? "").replace(/\D/g, "");
    if (!p) return "";
    if (p.startsWith("0")) return p.length === 10 ? "27" + p.slice(1) : "";
    if (p.startsWith("27")) return p.length === 11 ? p : "";
    return p.length >= 10 && p.length <= 15 ? p : "";
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Cohort by prior message count, as reported since run 7. */
export function cohortFor(n: number): "N" | "E" | "M" | "X" {
    return n === 0 ? "N" : n <= 3 ? "E" : n <= 6 ? "M" : "X";
}

/**
 * The upload row. The header names are the merge-field and column-role names the
 * WhatsApp template mapping and the email body already reference; `Contact ID`
 * is the tracking key and stays first.
 */
export const RUN_COLUMNS = [
    "Contact ID", "first_name", "full_name", "invoice_number", "invoice_issue_date",
    "amount_formatted", "payment_link", "email", "mobile", "whatsapp_optin", "amount",
    "payment_token", "invoice_age_days", "bad_debt_band", "has_paid_before",
    "paid_invoices_count", "consultant", "consultant_email", "consultant_disabled",
    "contact_id", "invoice_id", "bad_debt_id", "cohort", "messages_before",
    "invoices_in_scope", "owed_in_scope", "run",
] as const;
export type RunRow = Record<(typeof RUN_COLUMNS)[number], string>;

export type RunFile = "wa__30_60d" | "wa__60d_plus" | "email__30_60d" | "email__60d_plus";
export const RUN_FILES: readonly RunFile[] = ["wa__30_60d", "wa__60d_plus", "email__30_60d", "email__60d_plus"];

export type SkipReason = "missing contact or invoice" | "no payment token" | "no balance" | "no invoice number";

export interface BuildInput {
    chosen: readonly Chosen[];
    contacts: ReadonlyMap<string, ContactRow>;
    /** Live invoice rows for the chosen invoices, AFTER minting. */
    invoices: ReadonlyMap<string, InvoiceRow>;
    users: ReadonlyMap<string, SystemUserRow>;
    /** Paid invoices per customer — informational segment only since run 10. */
    paidCounts: ReadonlyMap<string, number>;
    /** Hard-bounced addresses per contact id. A bounce is on the address, not the person. */
    bounced: ReadonlyMap<string, ReadonlySet<string>>;
    paymentLinkBase: string;
    runLabel: string;
    today: Date;
}

export interface BuildResult {
    files: Record<RunFile, RunRow[]>;
    skipped: { contactId: string; name: string; amount: number; reason: SkipReason }[];
    unreachable: { contactId: string; name: string; amount: number }[];
    bouncedDropped: number;
}

/** Turn the chosen audience into the four upload files (build_run13.py). */
export function buildRunFiles(input: BuildInput): BuildResult {
    const skipped: BuildResult["skipped"] = [];
    const unreachable: BuildResult["unreachable"] = [];
    let bouncedDropped = 0;
    const wa: RunRow[] = [];
    const email: RunRow[] = [];
    const base = input.paymentLinkBase.replace(/\/+$/, "");

    for (const v of input.chosen) {
        const c = input.contacts.get(v.contactId);
        const inv = input.invoices.get(v.invoiceId);
        const skip = (reason: SkipReason) =>
            skipped.push({ contactId: v.contactId, name: v.name, amount: v.amount, reason });
        if (!c || !inv) { skip("missing contact or invoice"); continue; }
        const token = (inv.riivo_paymenttoken ?? "").trim();
        if (!token) { skip("no payment token"); continue; }
        const amt = inv.ttt_outstanding;
        if (amt == null || amt <= 0) { skip("no balance"); continue; }
        // Body param {{2}} of the WhatsApp template. Blank renders "invoice **" and Meta rejects it.
        const invno = (inv.ttt_invoiceid || inv.new_name || "").trim();
        if (!invno) { skip("no invoice number"); continue; }

        const owner = input.users.get(lower(inv._ownerid_value));
        const disabled = !!owner?.isdisabled;
        const npaid = input.paidCounts.get(lower(inv._ttt_customer_value)) ?? 0;
        const age = ageInDays(inv.createdon, input.today);
        const band = age < 60 ? "30-60d" : age < 90 ? "60-90d" : age < 365 ? "90d-1y" : "1-3y";
        const mobile = normalisePhone(c.mobilephone || c.icon_formattedmobilenumber || c.telephone1);
        const firstName = ((c.firstname || (c.fullname ?? "").split(" ")[0] || "there") ?? "").trim();

        const row: RunRow = {
            "Contact ID": v.contactId,
            first_name: firstName,
            full_name: (c.fullname ?? "").trim(),
            invoice_number: invno,
            invoice_issue_date: inv.createdon.slice(0, 10),
            amount_formatted: formatRand(amt),
            payment_link: `${base}/p/${token}`,
            email: v.email,
            mobile,
            whatsapp_optin: c.riivo_whatsappoptinout === true ? "Yes" : "No",
            amount: amt.toFixed(2),
            payment_token: token,
            invoice_age_days: String(age),
            bad_debt_band: band,
            has_paid_before: npaid > 0 ? "Yes" : "No",
            paid_invoices_count: String(npaid),
            consultant: (owner?.fullname ?? "").trim(),
            // A CC to a disabled mailbox bounces back into the shared inbox.
            consultant_email: disabled ? "" : (owner?.internalemailaddress ?? "").trim(),
            consultant_disabled: disabled ? "Yes" : "No",
            contact_id: v.contactId,
            invoice_id: v.invoiceId,
            bad_debt_id: v.badDebtId,
            cohort: `${cohortFor(v.messagesBefore)}${v.messagesBefore}`,
            messages_before: String(v.messagesBefore),
            invoices_in_scope: String(v.invoicesInScope),
            owed_in_scope: v.owedInScope.toFixed(2),
            run: input.runLabel,
        };

        const waOk = !!mobile && row.whatsapp_optin === "Yes";
        const addr = row.email.trim().toLowerCase();
        const stillBounced = input.bounced.get(v.contactId)?.has(addr) ?? false;
        if (stillBounced) bouncedDropped++;
        const emOk = EMAIL_RE.test(row.email) && !stillBounced;
        if (waOk) wa.push(row);
        if (emOk) email.push(row);
        if (!waOk && !emOk) unreachable.push({ contactId: v.contactId, name: v.name, amount: amt });
    }

    const byAmountDesc = (a: RunRow, b: RunRow) => Number(b.amount) - Number(a.amount);
    wa.sort(byAmountDesc);
    email.sort(byAmountDesc);
    const fresh = (r: RunRow) => Number(r.invoice_age_days) < AGE_SPLIT_DAYS;
    return {
        files: {
            wa__30_60d: wa.filter(fresh),
            wa__60d_plus: wa.filter((r) => !fresh(r)),
            email__30_60d: email.filter(fresh),
            email__60d_plus: email.filter((r) => !fresh(r)),
        },
        skipped,
        unreachable,
        bouncedDropped,
    };
}

/** Rows as the wizard's parser would see a CSV of them: header first, cells as strings. */
export function toGrid(rows: readonly RunRow[]): string[][] {
    return [[...RUN_COLUMNS], ...rows.map((r) => RUN_COLUMNS.map((c) => r[c]))];
}
