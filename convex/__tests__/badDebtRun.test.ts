import { describe, expect, it } from "vitest";
import {
    ageInDays, buildRunFiles, formatRand, normalisePhone, selectAudience,
    STATUS_PAID, STATUS_PENDING_SETTLEMENT,
    type BadDebtRow, type ContactRow, type InvoiceRow,
} from "../lib/badDebtRun/audience";
import { checkRunFiles } from "../lib/badDebtRun/checks";
import { gateFile } from "../lib/badDebtRun/gate";
import { classify, matchReplies } from "../lib/badDebtRun/replies";
import { foldCampaign, writeBackPlan } from "../lib/badDebtRun/ledger";

const TODAY = new Date("2026-10-19T06:00:00Z");
const daysAgo = (d: number) => new Date(TODAY.getTime() - d * 86_400_000).toISOString();
const guid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const BASE = "https://payment-link-ttt.azurewebsites.net";

function world() {
    const contacts = new Map<string, ContactRow>();
    const invoices: InvoiceRow[] = [];
    const badDebts: BadDebtRow[] = [];
    let n = 100;
    const client = (c: Partial<ContactRow> = {}) => {
        const id = guid(++n);
        contacts.set(id, {
            contactid: id, firstname: "Thandi", fullname: "Thandi Mokoena",
            emailaddress1: `c${n}@example.com`, mobilephone: "0821234567",
            riivo_whatsappoptinout: true, ...c,
        });
        return id;
    };
    const debt = (cust: string, age: number, amount: number, inv: Partial<InvoiceRow> = {}, bd: Partial<BadDebtRow> = {}) => {
        const invId = guid(++n);
        invoices.push({
            new_invoicesid: invId, ttt_invoiceid: `INV${n}`, statecode: 0, statuscode: 958140000,
            ttt_outstanding: amount, createdon: daysAgo(age), riivo_paymenttoken: `tok${n}`,
            _ttt_customer_value: cust, _ownerid_value: guid(1), ...inv,
        });
        const bdId = guid(++n);
        badDebts.push({
            riivo_baddebtid: bdId, statecode: 0, _riivo_invoice_value: invId,
            riivo_clientmobile: "0821234567", riivo_clientfullname: "Thandi Mokoena", ...bd,
        });
        return { invId, bdId };
    };
    return { contacts, invoices, badDebts, client, debt };
}

const select = (w: ReturnType<typeof world>, extra: { holds?: string[] } = {}) =>
    selectAudience({
        badDebts: w.badDebts, openInvoices: w.invoices, contacts: w.contacts,
        holds: new Set(extra.holds ?? []), messagesBefore: new Map(), today: TODAY,
    });

describe("selectAudience", () => {
    it("chases each client once, on their newest in-scope invoice", () => {
        const w = world();
        const c = w.client();
        w.debt(c, 400, 900);
        const newest = w.debt(c, 45, 300);
        w.debt(c, 10, 5000); // too fresh: not in scope, so not the one chased
        const { chosen } = select(w);
        expect(chosen).toHaveLength(1);
        expect(chosen[0].invoiceId).toBe(newest.invId);
        expect(chosen[0].invoicesInScope).toBe(2);
        expect(chosen[0].owedInScope).toBe(1200);
    });

    it("never chases Paid, Pending Settlement, R50-or-less, or prescribed debt", () => {
        const w = world();
        w.debt(w.client(), 100, 500, { statuscode: STATUS_PAID });
        w.debt(w.client(), 100, 500, { statuscode: STATUS_PENDING_SETTLEMENT });
        w.debt(w.client(), 100, 50);
        w.debt(w.client(), 1095, 500);
        const { chosen, excluded } = select(w);
        expect(chosen).toHaveLength(0);
        expect(excluded).toEqual([{ reason: "prescribed (>3 years)", people: 1, value: 500 }]);
    });

    it("holds do-not-contact, reply-held and unreachable people out, first reason wins", () => {
        const w = world();
        const dnc = w.client({ donotbulkemail: true });
        const held = w.client();
        const lost = w.client({ emailaddress1: null });
        w.debt(dnc, 100, 500);
        w.debt(held, 100, 600);
        w.debt(lost, 100, 700, {}, { riivo_clientmobile: null });
        const { chosen, excluded } = select(w, { holds: [held, dnc] });
        expect(chosen).toHaveLength(0);
        expect(Object.fromEntries(excluded.map((e) => [e.reason, e.people]))).toEqual({
            "do-not-contact": 1, "reply hold": 1, unreachable: 1,
        });
    });

    it("still chases a deactivated contact (run 8 decision)", () => {
        const w = world();
        w.debt(w.client({ statecode: 1 }), 100, 500);
        expect(select(w).chosen).toHaveLength(1);
    });
});

function build(w: ReturnType<typeof world>, opts: { bounced?: [string, string][]; disabledOwner?: boolean } = {}) {
    const { chosen } = select(w);
    const bounced = new Map<string, Set<string>>();
    for (const [c, a] of opts.bounced ?? []) bounced.set(c, new Set([a]));
    return buildRunFiles({
        chosen, contacts: w.contacts,
        invoices: new Map(w.invoices.map((i) => [i.new_invoicesid, i])),
        users: new Map([[guid(1), { systemuserid: guid(1), fullname: "Sheri", internalemailaddress: "sheri@ttt-tax.co.za", isdisabled: !!opts.disabledOwner }]]),
        paidCounts: new Map(), bounced, paymentLinkBase: BASE + "/", runLabel: "run14", today: TODAY,
    });
}

describe("buildRunFiles", () => {
    it("splits each channel at 60 days and orders biggest debt first", () => {
        const w = world();
        w.debt(w.client(), 40, 100);
        w.debt(w.client(), 200, 900);
        w.debt(w.client(), 300, 2000);
        const { files } = build(w);
        expect(files.wa__30_60d.map((r) => r.amount)).toEqual(["100.00"]);
        expect(files.wa__60d_plus.map((r) => r.amount)).toEqual(["2000.00", "900.00"]);
        expect(files.email__60d_plus).toHaveLength(2);
        const r = files.wa__60d_plus[0];
        expect(r.mobile).toBe("27821234567");
        expect(r.amount_formatted).toBe("R2,000.00");
        expect(r.payment_link).toBe(`${BASE}/p/${r.payment_token}`);
    });

    it("skips a row with no payment token rather than sending a dead button", () => {
        const w = world();
        w.debt(w.client(), 100, 500, { riivo_paymenttoken: null });
        const out = build(w);
        expect(out.skipped.map((s) => s.reason)).toEqual(["no payment token"]);
        expect(out.files.wa__60d_plus).toHaveLength(0);
    });

    it("drops a hard-bounced address from email only, and keeps WhatsApp", () => {
        const w = world();
        const c = w.client({ emailaddress1: "dead@example.com" });
        w.debt(c, 100, 500);
        const out = build(w, { bounced: [[c, "dead@example.com"]] });
        expect(out.files.email__60d_plus).toHaveLength(0);
        expect(out.files.wa__60d_plus).toHaveLength(1);
        expect(out.bouncedDropped).toBe(1);
    });

    it("sends WhatsApp only to opted-in mobiles, and blanks a CC to a disabled consultant", () => {
        const w = world();
        w.debt(w.client({ riivo_whatsappoptinout: false }), 100, 500);
        const out = build(w, { disabledOwner: true });
        expect(out.files.wa__60d_plus).toHaveLength(0);
        expect(out.files.email__60d_plus[0].consultant_email).toBe("");
    });
});

describe("checkRunFiles + gateFile", () => {
    it("a clean build passes every check and the wizard's gate holds nobody", () => {
        const w = world();
        w.debt(w.client({ emailaddress1: null }), 100, 500, {}, { riivo_clientemail: null }); // WhatsApp-only, blank email
        w.debt(w.client(), 45, 800);
        const { files } = build(w);
        expect(checkRunFiles(files, {
            paymentLinkBase: BASE, holds: new Set(), doNotContact: new Set(), bounced: new Map(), disabledMailboxes: new Set(),
        })).toEqual([]);

        const template = { variables: ["1", "2", "3"], buttonUrlVariable: "payment_link" };
        const wa = gateFile(files.wa__60d_plus, "whatsapp", { template });
        // Run 13's acceptance check: blank-email WhatsApp rows are NOT held.
        expect(wa.held).toEqual([]);
        expect(wa.recipients).toHaveLength(1);
        expect(wa.recipients[0].phone).toBe("27821234567");

        const em = gateFile(files.email__30_60d, "email", {
            subject: "Outstanding Invoice", htmlBody: "Hi {first_name}, {amount_formatted} <a href=\"{payment_link}\">Pay</a>",
        });
        expect(em.held).toEqual([]);
        expect(em.warnings).toEqual([]);
        expect(JSON.parse(em.recipients[0].variables!).consultant_email).toBe("sheri@ttt-tax.co.za");
    });

    it("flags a held person who slipped into a file", () => {
        const w = world();
        const c = w.client();
        w.debt(c, 100, 500);
        const { files } = build(w);
        const failures = checkRunFiles(files, {
            paymentLinkBase: BASE, holds: new Set([c]), doNotContact: new Set(), bounced: new Map(), disabledMailboxes: new Set(),
        });
        expect(failures).toContain("wa__60d_plus: someone on the reply-hold list");
    });

    it("an email placeholder no column fills is a warning, not a silent blank", () => {
        const w = world();
        w.debt(w.client(), 100, 500);
        const { files } = build(w);
        const em = gateFile(files.email__60d_plus, "email", { subject: "x", htmlBody: "Hi {nickname}" });
        expect(em.recipients).toHaveLength(0);
        expect(em.warnings[0]).toContain("nickname");
    });
});

describe("replies", () => {
    it("matches WhatsApp by normalised number and email by sender", () => {
        const c: ContactRow = { contactid: guid(5), mobilephone: "082 123 4567", emailaddress2: "Me@Example.com" };
        const m = matchReplies([
            { channel: "whatsapp", from: "27821234567", at: "t", text: "hi" },
            { channel: "email", from: "me@example.com", at: "t", text: "hi" },
            { channel: "email", from: "other@example.com", at: "t", text: "hi" },
        ], [c]);
        expect(m.map((x) => x.contactId)).toEqual([guid(5), guid(5)]);
    });

    it("buckets in rule order", () => {
        expect(classify(["Please stop sending me these"])).toBe("stop / POPIA");
        expect(classify(["I already paid this last week"])).toBe("claims already paid");
        expect(classify(["Will pay at month end"])).toBe("promises to pay");
        expect(classify(["ok thanks"])).toBe("acknowledged / other");
    });

    it("catches the run-14 phrasings the run-13 rules missed", () => {
        expect(classify(["Ive paid"])).toBe("claims already paid");
        expect(classify(["I've paid"])).toBe("claims already paid");
        expect(classify(["Its sorted with madison"])).toBe("claims already paid");
        expect(classify(["Please give untill end of this month"])).toBe("wants arrangement");
    });
});

describe("ledger", () => {
    it("folds sends, skips in-flight messages, and records email bounces by address", () => {
        const map = new Map([["c1", "bd1"], ["c2", "bd2"]]);
        const prior = new Map([["bd1", { badDebtId: "bd1", n: 5, first: "2026-07-01T00:00:00Z", last: "2026-09-29T00:00:00Z", bounced: false, fails: 0 }]]);
        const out = foldCampaign(prior, [
            { recipientId: "c1", status: "sent", channel: "whatsapp", at: "2026-10-19T09:00:00Z" },
            { recipientId: "c2", status: "failed", channel: "email", recipientEmail: "X@y.com", at: "2026-10-19T09:00:00Z" },
            { recipientId: "c2", status: "pending", channel: "whatsapp", at: "2026-10-19T09:00:00Z" },
            { recipientId: "c9", status: "sent", channel: "whatsapp", at: "2026-10-19T09:00:00Z" },
        ], map);
        expect(out.entries.get("bd1")).toMatchObject({ n: 6, first: "2026-07-01T00:00:00Z", last: "2026-10-19T09:00:00Z" });
        expect(out.entries.get("bd2")).toMatchObject({ n: 0, bounced: true, fails: 1 });
        expect(out.bounces).toEqual([{ contactId: "c2", address: "x@y.com" }]);
        expect(out.unmatched).toBe(1);
        expect(prior.get("bd1")!.n).toBe(5); // the input ledger is not mutated
    });

    it("write-back never moves a field backwards", () => {
        const plan = writeBackPlan(
            [{ badDebtId: "bd1", n: 3, first: "2026-08-01T00:00:00Z", last: "2026-10-19T09:00:00Z", bounced: false, fails: 0 }],
            new Map([["bd1", {
                riivo_baddebtid: "bd1", riivo_campaignsendcount: 7, riivo_campaignfirstsent: "2026-07-23T00:00:00Z",
                riivo_campaignlastsent: "2026-08-20T00:00:00Z", riivo_campaignbounced: true, riivo_outstandingamount: 500,
            }]]),
            new Map([["bd1", "2026-10-01T10:00:00Z"]]),
        );
        expect(plan).toEqual([{ id: "bd1", fields: {
            riivo_campaignlastsent: "2026-10-19T09:00:00Z",
            riivo_campaignlastreply: "2026-10-01T10:00:00Z",
            riivo_baselineoutstanding: 500,
        } }]);
    });
});

describe("small helpers", () => {
    it("ages, rands and phones", () => {
        expect(ageInDays("2026-10-18T23:59:00Z", TODAY)).toBe(1);
        expect(formatRand(1234.5)).toBe("R1,234.50");
        expect(normalisePhone("+27 82 123 4567")).toBe("27821234567");
        expect(normalisePhone("082123456")).toBe("");
    });
});
