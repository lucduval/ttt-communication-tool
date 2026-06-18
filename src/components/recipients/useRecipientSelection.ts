"use client";

import { useCallback, useMemo, useState } from "react";
import {
    emptySelection,
    explicitSelection,
    toggleContact,
    clearSelection,
    count,
    selectedContactIds,
    toCampaignArgs,
    type RecipientSelection,
    type SelectableContact,
    type Channel,
    type CampaignArgs,
} from "@/../convex/lib/recipientSelection";

/**
 * Thin React seam over the pure Recipient Selection core (issue #19).
 *
 * Holds the single selection value and exposes the explicit-shape transitions
 * plus the `count` / `toCampaignArgs` projections, so the recipients step, the
 * selected-count, and the send path all read from one value. All decisions live
 * in the pure core; this hook only owns the React state cell.
 */
export function useRecipientSelection() {
    const [selection, setSelection] = useState<RecipientSelection>(emptySelection);

    const setExplicit = useCallback((contacts: SelectableContact[]) => {
        setSelection(explicitSelection(contacts));
    }, []);

    const toggle = useCallback((contact: SelectableContact) => {
        setSelection((prev) => toggleContact(prev, contact));
    }, []);

    const clear = useCallback(() => {
        setSelection(clearSelection());
    }, []);

    const toArgs = useCallback(
        (opts: { channel: Channel; whatsappVariables?: string }): CampaignArgs =>
            toCampaignArgs(selection, opts),
        [selection],
    );

    return useMemo(
        () => ({
            selection,
            contacts: selection.contacts,
            count: count(selection),
            selectedIds: selectedContactIds(selection),
            setExplicit,
            toggle,
            clear,
            toCampaignArgs: toArgs,
        }),
        [selection, setExplicit, toggle, clear, toArgs],
    );
}
