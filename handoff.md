# Handoff — RALPH iteration

## Just completed: #38 — wire `materialiseExplicit` into the navigation effect (PRD #36)

**Issue #38 closed.** Branch: `main`.

Wired the `materialiseExplicit` helper (from #37) into the campaign builder so
the explicit recipient selection can no longer shrink when the consultant
advances from the recipients step to compose/preview.

What landed:
- **`src/app/campaigns/new/page.tsx`** — the navigation effect (~L734) that
  re-derives the explicit selection on entering `compose`/`preview` no longer
  picks a **single** record source (the old `allFilteredContactsRef.current ??
  contacts` intersection that collapsed Leads Select All to the first page).
  It now calls `materialiseExplicit(selectedIds, recipientSelection.contacts,
  contacts, allFilteredContactsRef.current)` — the prioritised union of the
  contacts already in the selection value, the on-screen page, and the
  first-page ref — so every selected id resolves to its full record.
  `materialiseExplicit` added to the `@/components/recipients` import.
- The headline 148→50 bug is fixed because `handleSelectAll` for Leads already
  stores all 148 records in the selection value via `setExplicit(allLeads)`;
  `recipientSelection.contacts` is now the highest-priority source, so the full
  148 survive navigation. Hand-picked leads on later pages survive the same way.
- `RecipientSelection` stays the single source of truth read by `toCampaignArgs`
  on the send path — unchanged.

**Verification:** `npm run typecheck` clean; `npm run test` = 1421 passed. The
union-resolution logic is covered by `materialiseExplicit.test.ts` (Select All
across multiple lead pages, manual cross-page selection, unchecks, client-side
filter modes). The wiring itself is a one-line swap into an already-tested pure
helper, so no new page-level test was added (the page has no render harness).

## Next up: no unblocked issue queued for this area

PRD #36's navigation-collapse slices (#37 helper, #38 wiring) are both done.
Check `gh issue list --label ready-for-agent` for the next highest-priority
unblocked issue.

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
