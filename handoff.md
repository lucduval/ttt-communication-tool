# Handoff — RALPH iteration

## Just completed: #37 — pure `materialiseExplicit` helper (PRD #36)

**Issue #37 closed.** Branch: `main`.

Added the recipients-module seam that materialises an explicit recipient
selection from a gesture and the contact-record sources available at navigation
time. This is the seam that stops the navigation path from collapsing a complete
selection down to whatever happened to be loaded on screen.

What landed:
- **`materialiseExplicit`** (`src/components/recipients/materialiseExplicit.ts`):
  pure, exported helper. Signature
  `materialiseExplicit(selectedIds: Set<string>, ...sources: SelectableContact[][])`.
  Walks `sources` in **priority order** (intended caller order: the contacts
  already in the selection value, the on-screen `contacts` array, the first-page
  `allFilteredContactsRef`), collecting the full record for each id in
  `selectedIds`. Earliest source wins for a shared id; first-encountered order is
  preserved; deduped. An id present in **any** source is never dropped because an
  earlier source was short. Unresolvable ids are simply absent (no phantom
  recipients). No React/Convex — mirrors `filterSignature`. Reuses
  `SelectableContact` from the pure core; `convex/lib/recipientSelection.ts` is
  **unchanged**.
- **Barrel export** added to `src/components/recipients/index.ts`.
- **Tests** (`materialiseExplicit.test.ts`, pure-function style mirroring
  `filterSignature.test.ts`): Select All across multiple lead pages (ids span
  pages, only page 1 in the stale ref), manual cross-page selection, unchecks
  after Select All, client-side filter mode (full set in one source — no
  regression), duplicate-id dedup, source priority, unresolvable ids, empty
  selection, non-selected ids ignored.

**Verification:** `npm run typecheck` clean; `npm run test` = 1421 passed.

## Next up: wire `materialiseExplicit` into the navigation effect (no issue filed yet)

The helper is built and tested but **not yet wired in**. The navigation effect in
`src/app/campaigns/new/page.tsx` (~L734) still uses the old logic:

```ts
const source = allFilteredContactsRef.current.length > 0
    ? allFilteredContactsRef.current
    : contacts;
recipientSelection.setExplicit(source.filter((c) => selectedIds.has(c.id)));
```

This is exactly the "collapse to whatever's loaded" bug #37 was built to fix:
it picks **one** source, so in lead-pagination mode (ids span pages but the ref
only holds page 1) the selection collapses. The follow-up slice should replace
this with `materialiseExplicit(selectedIds, recipientSelection.contacts,
contacts, allFilteredContactsRef.current)` (priority order TBD by the wiring
issue). **Do not wire it in until PRD #36 files that slice** — #37 was scoped to
the pure helper only.

### If picking up new work in this area
- Pure recipients primitives live in `src/components/recipients/`:
  `filterSignature.ts` and `materialiseExplicit.ts` are the pure-function
  reference pattern (+ their `.test.ts` siblings). The pure selection core is
  `convex/lib/recipientSelection.ts` (`SelectableContact`, the explicit/filtered
  shapes). The React seam is `useRecipientSelection.ts`.
- The consumer is `src/app/campaigns/new/page.tsx` — `selectedIds` (gesture
  Set), `contacts` (on-screen page), `allFilteredContactsRef` (first-page / full
  client-side set), and the `setExplicit` navigation effect at ~L734.

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing.
- Single commit, `RALPH:` prefix, list decisions/files/blockers.
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Update this `handoff.md` when the next issue is done, in the same fashion** —
  rewrite "Just completed" for the issue you finished, move "Next up" to the
  highest-priority unblocked issue with the same concrete pointers.
- Note: vitest also picks up copies under `.sandcastle/worktrees/**` — harmless
  duplication in the test counts, ignore it.
