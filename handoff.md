# Handoff — RALPH iteration

## Just completed: #52 — Smart id-column detection (tiers 2–3)

**Issue #52 closed.** Branch: `main`.

Fourth slice of PRD #48. Teaches the pure extraction core to find the id column
in real-world exports with zero clicks, trying detection tiers **in order**:

- **Tier 1 (pre-existing)** — explicit `contactid` header (case-insensitive, trimmed).
- **Tier 2 — Dynamics export.** The hidden `(Do Not Modify) <Entity>` GUID column
  standard Dynamics exports carry. Match is narrowed to the `(Do Not Modify)`-prefixed
  column whose **data is GUID-shaped**, so it lands on the GUID column and never the
  sibling `(Do Not Modify) Row Checksum` / `Modified On` columns.
- **Tier 3 — GUID-shape auto-detect.** When exactly one column's data is GUID-shaped
  (under any header), use it.

When no tier resolves to a single column we emit the existing `ambiguous` signal with
`candidates` populated (the #54 manual-choice seam) — **never guess**: two `contactid`
columns (tier 1), >1 GUID-shaped columns (candidates = the GUID columns), or zero
GUID-shaped columns (candidates = every column).

Changes (all in `src/components/recipients/`):
- **`extractContactIds.ts`**: refactored the body into tier 1 → 2 → 3 with two new
  pure helpers — `isGuidColumn(dataRows, index)` (true iff ≥1 non-blank cell and every
  non-blank cell normalises to a GUID; blanks ignored so they still skip-count at
  extraction) and `DO_NOT_MODIFY` prefix regex. Extracted the dedup/skip loop into
  `collect()` and the ambiguous result into `ambiguous()`. **Removed the `no-column`
  status** — it became unreachable (zero GUID columns now → `ambiguous`).
- **`extractContactIds.test.ts`**: 9 new tests across four describe blocks (tier 2
  Dynamics export + case-insensitive prefix + checksum-sibling avoidance; tier 3
  single-column + blanks + mixed-GUID rejection; precedence tier1>tier3 & tier2>tier3;
  ambiguous multi-GUID + zero-GUID). Rewrote the old `no-column` test into the
  zero-GUID `ambiguous` case.
- **`UploadListPanel.tsx`**: dropped the `no-column` branch from `errorMessage` and
  generalised the `ambiguous` copy to "Couldn't identify a single column of contact
  ids…" (covers both zero and multiple).

**Verification:** `npm run typecheck` clean; `npm test -- run` = 342 passed (9 new).

### Gotchas / decisions (read before #54)
- **Zero GUID-shaped columns → `ambiguous`** (not a dead-end "no column"). Per the
  issue + prior handoff: zero *or* multiple → manual choice. Candidates rule:
  GUID-shaped columns when any exist, else **all** columns (so #54's chooser is never
  empty). This is the contract #54 consumes.
- `isGuidColumn` is **strict** (every non-blank cell must be a GUID) so auto-detect
  never picks a column it can't trust. Tiers 1 & 2 (explicit/Dynamics header) still
  tolerate malformed rows via the `collect()` skip loop — only tier-3 sniffing is strict.
- Tier 2 only fires when **exactly one** `(Do Not Modify)` column is GUID-shaped;
  otherwise it falls through to tier 3 (which then sees multiple GUID columns →
  ambiguous, as expected).

## Next up: #53 — Resolved-contact preview sample (unblocked)

**#53 is unblocked** (#49 ✓, #50 ✓). Two parts:
1. **Honour `contactIds` in the Contact Query page-fetch / count path.** Today
   `contactIds` is wired only into the *streaming* path; the page-fetch/count path used
   for previews ignores it. Restrict that path to the `contactIds` set, **reusing the
   existing OR-ceiling chunking** (find it in the streaming path / `toContactFilter`).
   Prior-art test: `contactQuery.test.ts`.
2. **Surface a sample in the Recipients UI** after a successful upload. The seam is the
   `fetchSampleContacts` guard in `src/app/campaigns/new/page.tsx`, which currently
   returns an empty sample for a `{ contactIds }` filter. The preview must reflect
   **server-side** resolution (only contacts the user may see appear).

See `gh issue view 53` for the full acceptance list.

## Remaining PRD #48 slices (dependency order)
- #53 — Resolved-contact preview sample  ← **next, unblocked**
- #54 — Manual column choice for ambiguous files (blocked by #52 ✓ — the `ambiguous`
  status + `candidates[]` contract above is now fully in place: candidates are the
  GUID columns, or every column when none are GUID-shaped)

## Environment / gotchas
- `node_modules` is installed. `vitest` is not on PATH; use **`npm test -- run <path>`**
  (or `npm test -- run` for all).
- Pre-existing lint error in `page.tsx` (`react/no-unescaped-entities`) is **not ours** —
  lint is not in the RALPH gate (typecheck + test only). Leave it.
- Working tree carries **pre-existing unrelated** uncommitted changes
  (`convex/engagementAudit.ts`, `convex/lib/engagementTrust.ts` + test, `CONTEXT.md`,
  `convex/_generated/api.d.ts`, `.sandcastle/prompt.md`). I committed **only my files**.
  Leave the others alone.

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing.
- Single commit, `RALPH:` prefix, list decisions/files/blockers. Keep the commit scoped
  to the issue's files.
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Rewrite this `handoff.md` when the next issue is done.**
