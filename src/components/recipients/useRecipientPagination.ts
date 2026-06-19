"use client";

import { useCallback, useRef, useState } from "react";
import type { Contact } from "./ContactList";

/**
 * Owns the recipients list's pagination / scroll-accumulation state so it lives
 * in one place rather than as free-floating cells in the page (issue #22).
 *
 * - `nextPageToken` drives server-side "Load More" (skip token).
 * - `clientSideOffset` drives "Load More" for client-side filter modes that hold
 *   the full matching set in `allFilteredContactsRef` and slice it as you scroll.
 *
 * `reset()` is the single deliberate path back to the first batch — the reload
 * effect calls it on a real filter-value change, so incidental re-renders that
 * merely re-create the filter object no longer clear scroll progress.
 */
export function useRecipientPagination(pageSize: number) {
    const [nextPageToken, setNextPageToken] = useState<string | null>(null);
    const [clientSideOffset, setClientSideOffset] = useState(pageSize);
    // Holds the full client-side dataset for employee/ITA34/TaxReturn/lead modes
    // so Load More can slice it without refetching.
    const allFilteredContactsRef = useRef<Contact[]>([]);

    const reset = useCallback(() => {
        setNextPageToken(null);
        setClientSideOffset(pageSize);
        allFilteredContactsRef.current = [];
    }, [pageSize]);

    return {
        nextPageToken,
        setNextPageToken,
        clientSideOffset,
        setClientSideOffset,
        allFilteredContactsRef,
        reset,
    };
}
