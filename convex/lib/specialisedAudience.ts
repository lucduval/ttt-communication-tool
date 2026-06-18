/**
 * Specialised Audience module
 *
 * The single deep place that turns a *related-entity* audience (income / tax
 * return / bad debt / referral) into a stream of contacts. Every specialised
 * audience is the same two-step shape, and this module names both steps:
 *
 *   - A {@link ScanAdapter} — the only part that varies per audience. It owns
 *     the related-entity query, the collapse to one row per contact, and the
 *     in-memory membership test ("who is in range"). It returns the qualifying
 *     contact ids plus the per-contact scan figure.
 *   - One shared {@link resolveSpecialisedAudience resolver} — runs the adapter's
 *     scan, then re-queries those ids through Contact Query's `contactIds`
 *     dimension (so id-chunking and the OData dialect stay owned in one place),
 *     and joins each returned contact with its scan figure and, when asked, its
 *     Tax Profile display figure.
 *
 * The module never builds `contactid eq` clauses itself: that encoding lives in
 * Contact Query, reached here only through the `contactIds` dimension. Likewise
 * latest-year selection is reused from the Tax Profile module, never
 * reimplemented.
 */

import { dynamicsRequest } from "./dynamics_auth";
import {
    streamContacts,
    streamEntity,
    type ContactFilter,
    type DynamicsRequestFn,
} from "./contactQuery";
import { pickLatest, fetchTaxProfiles, type TaxProfileData } from "./taxProfile";

/**
 * The result of an audience scan: the contacts that pass the in-memory
 * membership test, plus the scan figure the membership was decided on, keyed by
 * contactId. The figure is what an audience whose displayed value *is* the scan
 * value (e.g. SARS reimbursement) shows; income audiences instead display the
 * Tax Profile figure the resolver joins on top.
 */
export interface ScanResult {
    contactIds: string[];
    figures: Map<string, number | null>;
}

/**
 * The per-audience contract. An adapter owns everything that varies between
 * audiences: the related-entity query, the collapse to one row per contact, and
 * the membership test. It is handed the injected request primitive so the same
 * adapter runs against the real boundary in production and a fake in tests.
 */
export interface ScanAdapter {
    scan(request: DynamicsRequestFn): Promise<ScanResult>;
}

/** A contact joined with the figures the resolver resolved for it. */
export interface ResolvedContact<T> {
    contact: T;
    extra: {
        /** The figure the adapter's membership decided on (e.g. latest-year income). */
        scanFigure: number | null;
        /** Tax Profile display data; null unless `withTaxProfile` was set. */
        taxProfile: TaxProfileData | null;
    };
}

/** Options for {@link resolveSpecialisedAudience}. */
export interface ResolveAudienceOptions<T extends { contactid: string }> {
    /** The audience's scan adapter. */
    adapter: ScanAdapter;
    /** Other contact-level clauses to re-apply to the re-query (owner scope, client type, …). */
    filter: ContactFilter;
    /** Columns to retrieve on the contact re-query ($select). */
    select: string;
    /** When set, join each contact with its Tax Profile display data. */
    withTaxProfile?: boolean;
    /** Order clause for the re-query; defaults to "fullname asc". */
    orderby?: string;
    /** Per-chunk id ceiling for the contactIds dimension. */
    contactIdChunkSize?: number;
    /** Injected request primitive; defaults to the real dynamicsRequest. */
    request?: DynamicsRequestFn;
    /** Injected backoff sleep; defaults to real timers. */
    sleep?: (ms: number) => Promise<void>;
    /** Injected Tax Profile batch read; defaults to the real fetchTaxProfiles. */
    fetchTaxProfilesFn?: (contactIds: string[]) => Promise<Map<string, TaxProfileData>>;
    /** Receives resolved `{ contact, extra }` items per streamed chunk, in stream order. */
    onChunk: (resolved: Array<ResolvedContact<T>>) => Promise<void> | void;
}

/**
 * Run an audience scan, then re-query the qualifying contact ids through Contact
 * Query's `contactIds` dimension — re-applying every other clause — and stream
 * each returned contact joined with its scan figure (and Tax Profile figure when
 * requested). An empty scan issues no contact request and joins no profiles.
 */
export async function resolveSpecialisedAudience<T extends { contactid: string }>(
    opts: ResolveAudienceOptions<T>
): Promise<void> {
    const request = opts.request ?? dynamicsRequest;
    const scan = await opts.adapter.scan(request);
    if (scan.contactIds.length === 0) return;

    let profiles = new Map<string, TaxProfileData>();
    if (opts.withTaxProfile) {
        const fetchProfiles = opts.fetchTaxProfilesFn ?? fetchTaxProfiles;
        profiles = await fetchProfiles(scan.contactIds);
    }

    await streamContacts<T>(
        { ...opts.filter, contactIds: scan.contactIds },
        {
            select: opts.select,
            orderby: opts.orderby,
            contactIdChunkSize: opts.contactIdChunkSize,
            request,
            sleep: opts.sleep,
            onPage: async (rows) => {
                const resolved = rows.map((contact) => ({
                    contact,
                    extra: {
                        scanFigure: scan.figures.get(contact.contactid) ?? null,
                        taxProfile: opts.withTaxProfile
                            ? profiles.get(contact.contactid) ?? null
                            : null,
                    },
                }));
                await opts.onChunk(resolved);
            },
        }
    );
}

/** A scanned ITA34 row — only the columns the income membership test needs. */
interface ITA34ScanRow {
    _riivo_taxpayercontact_value: string;
    riivo_income: number | null;
    riivo_retirementfundcontributions: number | null;
    riivo_yearofassessment: number | null;
}

const ITA34_SCAN_SELECT =
    "_riivo_taxpayercontact_value,riivo_income,riivo_retirementfundcontributions,riivo_yearofassessment";

/** The income / retirement filters that shape an ITA34 scan. */
export interface ITA34AudienceFilters {
    incomeMin?: number;
    incomeMax?: number;
    retirementFundMin?: number;
    retirementFundMax?: number;
    /** Restrict the scan to a single year of assessment. */
    taxYear?: number;
}

/**
 * The ITA34 income scan adapter: scan `riivo_ita34s`, collapse to each contact's
 * latest year via {@link pickLatest}, and test the income range against that
 * latest row.
 *
 * The income range is deliberately *not* an OData clause: applied server-side it
 * tests every year's row, so a contact would qualify on any year — even when the
 * latest year (the displayed figure) is out of range, which is exactly what made
 * the send disagree with the list (#25/#26). Retirement-fund and year filters,
 * which carry no such latest-row semantic, stay server-side. The scan figure is
 * the latest-year income; the displayed figure is taxable income, joined by the
 * resolver through the Tax Profile module.
 */
export function ita34IncomeScanAdapter(filters: ITA34AudienceFilters): ScanAdapter {
    return {
        async scan(request: DynamicsRequestFn): Promise<ScanResult> {
            let scanFilter = "statecode eq 0 and _riivo_taxpayercontact_value ne null";
            if (filters.taxYear) scanFilter += ` and riivo_yearofassessment eq ${filters.taxYear}`;
            if (filters.retirementFundMin !== undefined) {
                scanFilter += ` and riivo_retirementfundcontributions ge ${filters.retirementFundMin}`;
            }
            if (filters.retirementFundMax !== undefined) {
                scanFilter += ` and riivo_retirementfundcontributions le ${filters.retirementFundMax}`;
            }

            const rowsByContact = new Map<string, ITA34ScanRow[]>();
            await streamEntity<ITA34ScanRow>(scanFilter, {
                entity: "riivo_ita34s",
                select: ITA34_SCAN_SELECT,
                orderby: "riivo_yearofassessment desc",
                request,
                onPage: (rows) => {
                    for (const row of rows) {
                        const cid = row._riivo_taxpayercontact_value;
                        if (!cid) continue;
                        const list = rowsByContact.get(cid);
                        if (list) list.push(row);
                        else rowsByContact.set(cid, [row]);
                    }
                },
            });

            const contactIds: string[] = [];
            const figures = new Map<string, number | null>();
            for (const [cid, rows] of rowsByContact) {
                const latest = pickLatest(rows);
                const income = latest?.riivo_income ?? 0;
                if (filters.incomeMin !== undefined && income < filters.incomeMin) continue;
                if (filters.incomeMax !== undefined && income > filters.incomeMax) continue;
                contactIds.push(cid);
                figures.set(cid, latest?.riivo_income ?? null);
            }

            return { contactIds, figures };
        },
    };
}

/** A scanned invoice row — only the columns the tax-return collapse needs. */
interface InvoiceScanRow {
    _ttt_customer_value: string;
    ttt_sarsreimbursement: number | null;
    createdon: string;
}

const INVOICE_SCAN_SELECT = "_ttt_customer_value,ttt_sarsreimbursement,createdon";

/** The reimbursement threshold and year window that shape a tax-return scan. */
export interface TaxReturnAudienceFilters {
    /** Minimum `ttt_sarsreimbursement`; defaults to 0. */
    taxReturnMin?: number;
    /**
     * Calendar year whose invoices to scan (matched on `createdon`). The caller
     * resolves the default (previous year), so the adapter stays deterministic.
     */
    targetYear: number;
}

/**
 * The tax-return scan adapter: scan `new_invoiceses` for SARS reimbursements at
 * or above the threshold within the target-year window, and collapse to each
 * contact's highest reimbursement.
 *
 * Unlike the ITA34 adapter there is *no* in-memory membership test — the
 * threshold is the scan query itself, so every collapsed contact qualifies and
 * `contactIds` is simply the keys of the highest-per-contact map. The scan figure
 * is the reimbursement amount, which this audience displays directly (no Tax
 * Profile join), so the resolver is called with `withTaxProfile` unset.
 */
export function taxReturnScanAdapter(filters: TaxReturnAudienceFilters): ScanAdapter {
    return {
        async scan(request: DynamicsRequestFn): Promise<ScanResult> {
            const min = filters.taxReturnMin ?? 0;
            const yearStart = `${filters.targetYear}-01-01T00:00:00Z`;
            const yearEnd = `${filters.targetYear + 1}-01-01T00:00:00Z`;
            const scanFilter =
                `ttt_sarsreimbursement ge ${min}` +
                ` and createdon ge ${yearStart} and createdon lt ${yearEnd}` +
                ` and _ttt_customer_value ne null and statecode eq 1`;

            const figures = new Map<string, number | null>();
            await streamEntity<InvoiceScanRow>(scanFilter, {
                entity: "new_invoiceses",
                select: INVOICE_SCAN_SELECT,
                orderby: "ttt_sarsreimbursement desc",
                request,
                onPage: (rows) => {
                    for (const row of rows) {
                        const cid = row._ttt_customer_value;
                        if (!cid) continue;
                        const amount = row.ttt_sarsreimbursement ?? 0;
                        const existing = figures.get(cid);
                        if (existing === undefined || amount > (existing ?? 0)) {
                            figures.set(cid, row.ttt_sarsreimbursement ?? null);
                        }
                    }
                },
            });

            return { contactIds: Array.from(figures.keys()), figures };
        },
    };
}
