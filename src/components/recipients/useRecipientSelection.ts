"use client";

import { useCallback, useMemo, useState } from "react";
import {
    emptySelection,
    explicitSelection,
    filteredSelection,
    uploadSelection,
    toggleContact,
    deselectContact,
    reselectContact,
    clearSelection,
    count,
    selectedContactIds,
    excludedContactIds,
    isFiltered,
    toCampaignArgs,
    type RecipientSelection,
    type SelectableContact,
    type FilterPayload,
    type Channel,
    type CampaignArgs,
    type CampaignRecipient,
} from "@/../convex/lib/recipientSelection";

/**
 * Thin React seam over the pure Recipient Selection core (issues #19, #20).
 *
 * Holds the single selection value and exposes both shapes' transitions plus
 * the `count` / `toCampaignArgs` projections, so the recipients step, the
 * selected-count, and the send path all read from one value. All decisions live
 * in the pure core; this hook only owns the React state cell.
 */
export function useRecipientSelection() {
    const [selection, setSelection] = useState<RecipientSelection>(emptySelection);

    const setExplicit = useCallback((contacts: SelectableContact[]) => {
        setSelection(explicitSelection(contacts));
    }, []);

    const activateFiltered = useCallback((filters: FilterPayload, total: number) => {
        setSelection(filteredSelection(filters, total));
    }, []);

    // Activate an uploaded file's already-materialised recipients (issue #65).
    const activateUpload = useCallback((recipients: CampaignRecipient[]) => {
        setSelection(uploadSelection(recipients));
    }, []);

    const toggle = useCallback((contact: SelectableContact) => {
        setSelection((prev) => toggleContact(prev, contact));
    }, []);

    const deselect = useCallback((id: string) => {
        setSelection((prev) => deselectContact(prev, id));
    }, []);

    const reselect = useCallback((id: string) => {
        setSelection((prev) => reselectContact(prev, id));
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
            contacts: selection.shape === "explicit" ? selection.contacts : [],
            count: count(selection),
            selectedIds: selectedContactIds(selection),
            isFiltered: isFiltered(selection),
            deselectedIds: excludedContactIds(selection),
            setExplicit,
            activateFiltered,
            activateUpload,
            toggle,
            deselect,
            reselect,
            clear,
            toCampaignArgs: toArgs,
        }),
        [selection, setExplicit, activateFiltered, activateUpload, toggle, deselect, reselect, clear, toArgs],
    );
}
