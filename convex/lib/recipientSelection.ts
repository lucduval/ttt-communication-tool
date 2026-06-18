/**
 * Recipient Selection module — pure core (PRD: lead-query / recipient-selection, issue #19)
 *
 * Owns *who a campaign sends to* as a single value. A selection is in exactly
 * one of two mutually-exclusive shapes (CONTEXT.md): **explicit** (hand-picked
 * contacts held in memory) or **filtered** (a Contact Query filter plus an
 * excluded-id set). This slice introduces the **explicit** shape end-to-end;
 * the filtered shape arrives in a later slice.
 *
 * Everything here is pure — no React, no Convex — so the selection value and its
 * projections are the test surface. The three projections (`count`, `sample`,
 * `toCampaignArgs`) always agree because they derive from the same value. This
 * slice ships `count` and `toCampaignArgs` (`sample` arrives with the filtered
 * shape, which needs a query fetch).
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

/** The single selection value. Only the explicit shape exists in this slice. */
export type RecipientSelection = ExplicitSelection;

/** One materialised recipient in the `recipients[]` payload the send path consumes. */
export interface CampaignRecipient {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    variables?: string;
}

/** The recipient payload `toCampaignArgs` yields for the explicit shape. */
export interface CampaignArgs {
    recipients: CampaignRecipient[];
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
 * Toggle one contact in the explicit selection: remove it if already selected
 * (matched by id), otherwise append it. Insertion order of the survivors is
 * preserved.
 */
export function toggleContact(
    selection: RecipientSelection,
    contact: SelectableContact,
): RecipientSelection {
    const exists = selection.contacts.some((c) => c.id === contact.id);
    const contacts = exists
        ? selection.contacts.filter((c) => c.id !== contact.id)
        : [...selection.contacts, contact];
    return { shape: "explicit", contacts };
}

/** Clear the selection back to empty. */
export function clearSelection(): RecipientSelection {
    return emptySelection();
}

/** `count` projection: the recipient total. */
export function count(selection: RecipientSelection): number {
    return selection.contacts.length;
}

/** The set of currently-selected contact ids — used to drive checkbox state. */
export function selectedContactIds(selection: RecipientSelection): Set<string> {
    return new Set(selection.contacts.map((c) => c.id));
}

/**
 * `toCampaignArgs` projection: the materialised `recipients[]` payload the send
 * path consumes, keyed by channel.
 *
 * - email / personalised: every selected contact with an email address, as
 *   `{ id, email, name }`.
 * - whatsapp: every selected contact reachable by phone (international preferred,
 *   falling back to local), as `{ id, phone, name, variables }`.
 */
export function toCampaignArgs(
    selection: RecipientSelection,
    opts: { channel: Channel; whatsappVariables?: string },
): CampaignArgs {
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
