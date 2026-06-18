/**
 * Recipient Selection module — pure core (PRD: lead-query / recipient-selection, issue #19)
 *
 * Owns *who a campaign sends to* as a single value. A selection is in exactly
 * one of two mutually-exclusive shapes (CONTEXT.md): **explicit** (hand-picked
 * contacts held in memory) or **filtered** ("select all" over a Contact Query —
 * the captured filter plus an excluded-id set, i.e. "everyone matching, minus
 * these unchecks"). Both shapes ship here.
 *
 * Everything here is pure — no React, no Convex — so the selection value and its
 * projections are the test surface. The projections (`count`, `toCampaignArgs`)
 * always agree because they derive from the same value: `count` is
 * `total − excluded` for the filtered shape, and `toCampaignArgs` hands the
 * backend a `{ filters }` payload to re-resolve. (`sample` arrives in a later
 * slice — it needs a query fetch for the filtered shape.)
 */

/** The minimal contact fields the selection needs to count and materialise sends. */
export interface SelectableContact {
    id: string;
    fullName: string;
    email?: string | null;
    phone?: string | null;
    internationalPhone?: string | null;
}

/** The channel a campaign sends through — decides which recipient payload shape `toCampaignArgs` yields. */
export type Channel = "email" | "whatsapp" | "personalised";

/** Hand-picked contacts held in memory. */
export interface ExplicitSelection {
    shape: "explicit";
    contacts: SelectableContact[];
}

/**
 * An opaque Contact Query filter, captured verbatim when "select all" is
 * activated. The core treats it as a black box — only the page (and the
 * backend, which re-resolves it) knows its fields — so the module stays
 * domain-agnostic.
 */
export type FilterPayload = Record<string, unknown>;

/**
 * "Select all" over a Contact Query: everyone matching `filters`, minus the
 * contacts in `excludeContactIds`. `total` is the matching count captured at
 * activation time, so `count` can report `total − excluded` without a refetch.
 */
export interface FilteredSelection {
    shape: "filtered";
    filters: FilterPayload;
    excludeContactIds: string[];
    total: number;
}

/** The single selection value — one of the two mutually-exclusive shapes. */
export type RecipientSelection = ExplicitSelection | FilteredSelection;

/** One materialised recipient in the `recipients[]` payload the send path consumes. */
export interface CampaignRecipient {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    variables?: string;
}

/**
 * What `toCampaignArgs` yields. Exactly one field is populated, by shape:
 * `recipients` (a materialised array) for the explicit shape, or `filters` (a
 * JSON string the backend re-resolves) for the filtered shape.
 */
export interface CampaignArgs {
    recipients?: CampaignRecipient[];
    filters?: string;
}

/** An empty explicit selection — the starting value. */
export function emptySelection(): RecipientSelection {
    return { shape: "explicit", contacts: [] };
}

/** Replace the explicit selection with exactly these contacts ("select all loaded" / set). */
export function explicitSelection(contacts: SelectableContact[]): RecipientSelection {
    return { shape: "explicit", contacts: [...contacts] };
}

/**
 * Activate "select all" over a Contact Query: capture the filter verbatim and
 * the matching `total`, with nothing excluded yet. Replaces whatever shape the
 * selection was in (hand-picks are dropped — one shape at a time).
 */
export function filteredSelection(filters: FilterPayload, total: number): RecipientSelection {
    return { shape: "filtered", filters: { ...filters }, excludeContactIds: [], total };
}

/**
 * Toggle one contact into the explicit selection: remove it if already selected
 * (matched by id), otherwise append it. Insertion order of the survivors is
 * preserved. Hand-picking from a filtered selection starts a fresh explicit one
 * (one shape at a time).
 */
export function toggleContact(
    selection: RecipientSelection,
    contact: SelectableContact,
): RecipientSelection {
    const current = selection.shape === "explicit" ? selection.contacts : [];
    const exists = current.some((c) => c.id === contact.id);
    const contacts = exists
        ? current.filter((c) => c.id !== contact.id)
        : [...current, contact];
    return { shape: "explicit", contacts };
}

/**
 * Uncheck one contact from a filtered "select all": add it to the excluded set.
 * Idempotent. A no-op on the explicit shape (there is nothing to exclude from).
 */
export function deselectContact(
    selection: RecipientSelection,
    id: string,
): RecipientSelection {
    if (selection.shape !== "filtered") return selection;
    if (selection.excludeContactIds.includes(id)) return selection;
    return { ...selection, excludeContactIds: [...selection.excludeContactIds, id] };
}

/** Re-check a previously-unchecked contact in a filtered "select all". */
export function reselectContact(
    selection: RecipientSelection,
    id: string,
): RecipientSelection {
    if (selection.shape !== "filtered") return selection;
    return {
        ...selection,
        excludeContactIds: selection.excludeContactIds.filter((x) => x !== id),
    };
}

/** Clear the selection back to empty. */
export function clearSelection(): RecipientSelection {
    return emptySelection();
}

/** Whether the selection is the filtered "select all" shape. */
export function isFiltered(selection: RecipientSelection): boolean {
    return selection.shape === "filtered";
}

/**
 * `count` projection: the recipient total. Explicit → the number of hand-picks;
 * filtered → `total − excluded` (never negative).
 */
export function count(selection: RecipientSelection): number {
    if (selection.shape === "filtered") {
        return Math.max(0, selection.total - selection.excludeContactIds.length);
    }
    return selection.contacts.length;
}

/**
 * The set of currently-selected contact ids — drives checkbox state in the
 * explicit shape. Empty in the filtered shape, where checks are driven by the
 * excluded set instead (see `excludedContactIds`).
 */
export function selectedContactIds(selection: RecipientSelection): Set<string> {
    if (selection.shape !== "explicit") return new Set();
    return new Set(selection.contacts.map((c) => c.id));
}

/** The set of contacts unchecked from a filtered "select all" (empty otherwise). */
export function excludedContactIds(selection: RecipientSelection): Set<string> {
    if (selection.shape !== "filtered") return new Set();
    return new Set(selection.excludeContactIds);
}

/**
 * `toCampaignArgs` projection: the payload the send path consumes.
 *
 * Filtered shape → `{ filters }`: the captured Contact Query serialised to JSON
 * with `excludeContactIds` appended (omitted when nothing is unchecked), for the
 * backend to re-resolve. Channel-independent — the backend applies the channel.
 *
 * Explicit shape → `{ recipients }`, the materialised array, keyed by channel:
 * - email / personalised: every selected contact with an email address, as
 *   `{ id, email, name }`.
 * - whatsapp: every selected contact reachable by phone (international preferred,
 *   falling back to local), as `{ id, phone, name, variables }`.
 */
export function toCampaignArgs(
    selection: RecipientSelection,
    opts: { channel: Channel; whatsappVariables?: string },
): CampaignArgs {
    if (selection.shape === "filtered") {
        return {
            filters: JSON.stringify({
                ...selection.filters,
                excludeContactIds:
                    selection.excludeContactIds.length > 0
                        ? [...selection.excludeContactIds]
                        : undefined,
            }),
        };
    }

    if (opts.channel === "whatsapp") {
        const recipients = selection.contacts
            .filter((c) => c.internationalPhone || c.phone)
            .map((c) => ({
                id: c.id,
                phone: (c.internationalPhone || c.phone)!,
                name: c.fullName,
                variables: opts.whatsappVariables,
            }));
        return { recipients };
    }

    const recipients = selection.contacts
        .filter((c) => c.email)
        .map((c) => ({
            id: c.id,
            email: c.email!,
            name: c.fullName,
        }));
    return { recipients };
}
