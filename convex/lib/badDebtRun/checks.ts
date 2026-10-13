/**
 * The pre-send checks every hand-built run had to pass before it was uploaded
 * (`verify13.py`, "ALL CHECKS PASSED"). Any failure pauses the weekly run instead
 * of sending it.
 */
import {
    AGE_CEILING_DAYS, AGE_FLOOR_DAYS, AGE_SPLIT_DAYS, AMOUNT_FLOOR, RUN_FILES,
    type RunFile, type RunRow,
} from "./audience";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface CheckContext {
    paymentLinkBase: string;
    holds: ReadonlySet<string>;
    doNotContact: ReadonlySet<string>;
    bounced: ReadonlyMap<string, ReadonlySet<string>>;
    /** Lowercased internal addresses of disabled system users. */
    disabledMailboxes: ReadonlySet<string>;
}

export function checkRunFiles(files: Record<RunFile, RunRow[]>, ctx: CheckContext): string[] {
    const failures: string[] = [];
    const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };
    const base = ctx.paymentLinkBase.replace(/\/+$/, "");

    for (const f of RUN_FILES) {
        const rows = files[f];
        const ids = rows.map((r) => r["Contact ID"]);
        check(new Set(ids).size === ids.length, `${f}: a contact appears twice`);
        check(ids.every((i) => GUID.test(i)), `${f}: a contact id is not a lowercase GUID`);
        check(rows.every((r) => Number(r.amount) > AMOUNT_FLOOR), `${f}: an amount is not above R${AMOUNT_FLOOR}`);
        const ages = rows.map((r) => Number(r.invoice_age_days));
        check(ages.every((a) => a >= AGE_FLOOR_DAYS && a < AGE_CEILING_DAYS), `${f}: an invoice is outside 30 days to 3 years`);
        const fresh = f.endsWith("30_60d");
        check(ages.every((a) => (fresh ? a < AGE_SPLIT_DAYS : a >= AGE_SPLIT_DAYS)), `${f}: an invoice is in the wrong age file`);
        for (const col of ["first_name", "amount_formatted", "payment_link", "invoice_id"] as const) {
            check(rows.every((r) => r[col].trim() !== ""), `${f}: blank ${col}`);
        }
        check(rows.every((r) => GUID.test(r.invoice_id)), `${f}: an invoice id is not a GUID (no PDF)`);
        check(
            rows.every((r) => r.payment_token && !/\s|\//.test(r.payment_token) && r.payment_link === `${base}/p/${r.payment_token}`),
            `${f}: a payment token is not bare, or its link does not match it`,
        );
        if (f.startsWith("wa__")) {
            check(rows.every((r) => r.invoice_number.trim() !== ""), `${f}: blank invoice number (template {{2}})`);
            check(rows.every((r) => /^27\d{9}$|^[1-9]\d{9,14}$/.test(r.mobile)), `${f}: a mobile is not E.164 digits`);
            check(rows.every((r) => r.whatsapp_optin === "Yes"), `${f}: a row is not opted in to WhatsApp`);
        } else {
            check(rows.every((r) => EMAIL.test(r.email)), `${f}: a malformed email address`);
            check(
                rows.every((r) => !ctx.bounced.get(r["Contact ID"])?.has(r.email.trim().toLowerCase())),
                `${f}: an address that hard-bounced before`,
            );
        }
        check(rows.every((r) => !ctx.holds.has(r["Contact ID"])), `${f}: someone on the reply-hold list`);
        check(rows.every((r) => !ctx.doNotContact.has(r["Contact ID"])), `${f}: a do-not-contact contact`);
        check(
            rows.every((r) => !r.consultant_email || !ctx.disabledMailboxes.has(r.consultant_email.toLowerCase())),
            `${f}: a CC to a disabled mailbox`,
        );
    }

    const all = RUN_FILES.flatMap((f) => files[f]);
    const perPerson = new Map<string, number>();
    const tokenPeople = new Map<string, Set<string>>();
    const invoicePeople = new Map<string, Set<string>>();
    for (const r of all) {
        const id = r["Contact ID"];
        perPerson.set(id, (perPerson.get(id) ?? 0) + 1);
        tokenPeople.set(r.payment_token, (tokenPeople.get(r.payment_token) ?? new Set()).add(id));
        invoicePeople.set(r.invoice_id, (invoicePeople.get(r.invoice_id) ?? new Set()).add(id));
    }
    check([...perPerson.values()].every((n) => n <= 2), "someone gets more than one message per channel");
    check([...tokenPeople.values()].every((s) => s.size === 1), "a payment token is on two people");
    check([...invoicePeople.values()].every((s) => s.size === 1), "an invoice is on two people");
    for (const ch of ["wa", "email"] as const) {
        const young = new Set(files[`${ch}__30_60d`].map((r) => r["Contact ID"]));
        check(files[`${ch}__60d_plus`].every((r) => !young.has(r["Contact ID"])), `${ch}: someone is in both age files`);
    }
    return failures;
}
