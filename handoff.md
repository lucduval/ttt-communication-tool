# Handoff — RALPH iteration

## Just completed: #53 — Resolved-contact preview sample

**Issue #53 closed.** Branch: `main`. Commit `aff5982`.

Fifth slice of PRD #48. The `contactIds` dimension was wired only into the
*streaming* path (#49). This slice teaches the Contact Query **page-fetch** and
**count** paths to honour it too, reusing the OR-ceiling chunking, and surfaces a
server-resolved preview sample after an uploaded-list selection.

Changes:
- **`convex/lib/contactQuery.ts`**
  - **`countContacts`** with `contactIds`: chunk the ids under
    `CONTACT_ID_OR_CEILING`, re-apply every other clause per chunk, **sum** the
    per-chunk `countEntity` results. Chunks are disjoint id sets so the sum is
    exact. Added `contactIdChunkSize?` to `CountContactsOptions`. Empty set → `0`,
    no request.
  - **`fetchContactsPage`** with `contactIds`: new private
    **`fetchContactsPageByIds`** accumulates resolved rows across chunks until the
    page (`pageSize`) is full, then **stops** — a small preview touches only the
    first chunk(s). Builds a fresh per-chunk filter, so the `cursor` option is
    **ignored** on this path (the id-sample is a bounded fetch, not a cursor
    walk). `countOnly` sums per-chunk `@odata.count` (each chunk ≤ ceiling, so
    never capped). Added `contactIdChunkSize?` to `FetchContactsPageOptions`.
    Empty set → empty page, no request.
- **`convex/actions/dynamics.ts`**: `fetchContacts` and `getContactCount` accept
  `contactIds: v.optional(v.array(v.string()))` and pass it through. Owner scope
  still applied via `resolveEffectiveOwnerId`, so only contacts the user may see
  resolve (server-side resolution).
- **`src/app/campaigns/new/page.tsx`**: `fetchSampleContacts` now resolves the
  uploaded ids by calling `fetchContacts({ top: n, contactIds })` instead of the
  #50 placeholder that returned `[]`. The `useRecipientSample` hook already feeds
  this for the filtered shape, so the preview fills automatically.
- **`convex/lib/__tests__/contactQuery.test.ts`**: 10 new tests — `countContacts
  with contactIds` (single chunk / fan-out sum / composes with owner / empty) and
  `fetchContactsPage with contactIds` (single chunk / accumulate across chunks /
  stop at pageSize / composes / empty / countOnly sum).

**Verification:** `npm run typecheck` clean; `npm test -- run` = 352 passed (10 new).

### Gotchas / decisions
- Both new paths build their filter from the **typed object** (`buildContactFilter`),
  so owner scope and channel reachability are re-applied to every chunk — the
  preview can never leak a contact the user isn't scoped to.
- `fetchContactsPageByIds` ignores `cursor` on purpose. The id-restricted fetch is
  a bounded sample (accumulate-until-full), not a paged walk; cross-chunk cursor
  continuation isn't defined. Fine for the preview (small `top`). The non-`contactIds`
  branch is untouched and still cursor-paginates the standard recipient list.
- `countOnly` per-chunk counts are exact because each chunk holds ≤ ceiling (50)
  ids — far below the Dynamics 5000 `@odata.count` cap — so no pagination fallback
  is needed there.
- `convex/_generated/api.d.ts` was **not** committed by me: codegen left it carrying
  only the pre-existing `engagementAudit`/`engagementTrust` entries (the added
  optional action arg doesn't change the `typeof`-based decls). Left it with the
  other pre-existing changes.

## Next up: #54 — Manual column choice for ambiguous files (unblocked)

**#54 is unblocked** (#52 ✓). The `ambiguous` status + `candidates[]` contract is
fully in place from #52: candidates are the GUID-shaped columns when any exist,
else **every** column (so the chooser is never empty).

What to build (`gh issue view 54` for the full acceptance list):
1. When `extractContactIds` returns the **`ambiguous`** status, the Recipients UI
   (`src/components/recipients/UploadListPanel.tsx`) shows a **dropdown of the
   file's columns** (use `candidates`).
2. Picking a column runs that column through the **same validate / dedupe / skip
   pipeline** as auto-detection — i.e. re-extract using the chosen column index as
   the id column, reusing the existing `collect()` path in `extractContactIds.ts`
   rather than hand-rolling a second dedupe.
3. The chosen column **activates the `{ contactIds }` filtered selection** with the
   same count / skip summary as auto-detected files (same `handleUploadResult` /
   `activateFiltered` seam in `page.tsx`).
4. Auto-detected (tier 1–3) files **do not** show the dropdown.

Likely seam: `extractContactIds` needs an entry point that takes an explicit
column index (the manual choice) and runs tiers' shared `collect()` over it. Check
whether one already exists before adding; keep the pure core pure and the UI thin.

## Remaining PRD #48 slices (dependency order)
- #54 — Manual column choice for ambiguous files  ← **next, unblocked**
- (Check `gh issue list` for anything after #54 under PRD #48.)

## Environment / gotchas
- `node_modules` is installed. `vitest` is not on PATH; use **`npm test -- run <path>`**
  (or `npm test -- run` for all).
- Pre-existing lint error in `page.tsx` (`react/no-unescaped-entities`) is **not ours** —
  lint is not in the RALPH gate (typecheck + test only). Leave it.
- Working tree carries **pre-existing unrelated** uncommitted changes
  (`convex/engagementAudit.ts`, `convex/lib/engagementTrust.ts` + test, `CONTEXT.md`,
  `convex/_generated/api.d.ts`, `.sandcastle/prompt.md`). I committed **only my
  files**. Leave the others alone.

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing.
- Single commit, `RALPH:` prefix, list decisions/files/blockers. Keep the commit scoped
  to the issue's files.
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Rewrite this `handoff.md` when the next issue is done.**
