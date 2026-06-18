"use client";

import { useEffect, useRef, useState } from "react";
import {
    sample as sampleCore,
    type RecipientSelection,
    type SelectableContact,
    type FilterPayload,
} from "@/../convex/lib/recipientSelection";

/**
 * Resolves up to `n` concrete contacts to show in the preview, from the single
 * Recipient Selection value (issue #21).
 *
 * Explicit ("hand-picked") shape → the first `n` contacts straight from memory,
 * via the pure-core `sample` projection; no fetch, no async.
 *
 * Filtered ("select all over a Contact Query") shape → the core holds only the
 * captured filter, so we fetch the first `n` matching clients through the
 * injected `fetchSample` (a Convex action wired at the page). The fetch is keyed
 * on a stable serialisation of the filter values plus `n`, so it re-runs only
 * when the query or sample size actually changes — incidental re-renders don't
 * refetch. The result carries its own key, so an in-flight or superseded fetch
 * shows nothing rather than a stale sample from a previous query.
 *
 * This is the seam that fixes the blank "select all" preview: the sample now
 * derives from the same selection value as the count and the send payload.
 */
export function useRecipientSample(
    selection: RecipientSelection,
    n: number,
    fetchSample: (filters: FilterPayload, n: number) => Promise<SelectableContact[]>,
): SelectableContact[] {
    const [result, setResult] = useState<{ key: string; contacts: SelectableContact[] }>({
        key: "",
        contacts: [],
    });

    // Convex `useAction` returns a fresh function each render; hold it in a ref so
    // it isn't an effect dependency (which would refetch on every render).
    const fetchRef = useRef(fetchSample);
    useEffect(() => {
        fetchRef.current = fetchSample;
    });

    const isFiltered = selection.shape === "filtered";
    // Serialise the filter *values* so the effect keys on what changed, not on the
    // object identity the page re-creates each render.
    const filterKey = isFiltered ? JSON.stringify(selection.filters) : null;
    const resultKey = filterKey === null ? null : `${filterKey}:${n}`;

    useEffect(() => {
        if (filterKey === null || resultKey === null) return;
        let cancelled = false;
        fetchRef.current(JSON.parse(filterKey) as FilterPayload, n)
            .then((contacts) => {
                if (!cancelled) setResult({ key: resultKey, contacts });
            })
            .catch(() => {
                if (!cancelled) setResult({ key: resultKey, contacts: [] });
            });
        return () => {
            cancelled = true;
        };
    }, [filterKey, resultKey, n]);

    if (!isFiltered) return sampleCore(selection, n);
    // Only trust the fetched sample once it matches the active query + size; an
    // in-flight or superseded fetch shows nothing rather than a stale sample.
    return result.key === resultKey ? result.contacts.slice(0, n) : [];
}
