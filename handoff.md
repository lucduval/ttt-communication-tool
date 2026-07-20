# Handoff — RALPH iteration

## Just completed: #65 — `resolveColumnRoles` (persisted-header → index bridge)

**Issue #65 remains open** (see "still open" below). Commit on `main`.

Added the pure `resolveColumnRoles(columns, persistedRoles)` bridge in
`src/components/recipients/columnRoles.ts`. The campaign schema persists column
roles **by header** (`campaigns.columnRoles`: `{ sendAddress?, trackingKey,
invoiceGuid? }`) so a designation survives a re-export, but `materialiseRecipients`
consumes roles **by index** (`ColumnRoles`). Nothing bridged them — this is the
missing AC #4 → #5 link: at send time the upload is re-read into columns and the
persisted headers are re-resolved to whatever positions they now occupy.

**Changes:**
- **`columnRoles.ts`** — new `resolveColumnRoles` + types `PersistedColumnRoles`,
  `UnresolvedRole`, `ResolveColumnRolesResult`. Matches each designated header
  (trimmed) against the already-trimmed column headers; duplicate header → first
  occurrence; optional roles unset (absent/null/blank) → `null`; a missing
  required `trackingKey` (or any designated optional header) → `unresolved`,
  listing missing roles in `sendAddress → trackingKey → invoiceGuid` order so the
  caller can hold the upload instead of materialising against the wrong columns.
- **`columnRoles.test.ts`** (+8) — resolve-all, optional-unset, re-export
  reordering (durability), header trimming, unresolved (required + optionals in
  role order), duplicate-header first-wins, and a round-trip straight into
  `materialiseRecipients`. Prior art: the existing `columnRoles` tests.
- **`index.ts`** — export the new function + types from the recipients barrel.

**Verified:** RGR — 8 red (`resolveColumnRoles is not a function`) → green.
`npm run typecheck` clean. Full suite **426 pass + the 3 known pre-existing
`recomputeCampaignStats` failures** (the untouched `delivered = sent` WIP — see
below); no new regressions. My three files don't overlap the WIP, so a plain
`git add` of them kept the commit scoped (no checkout dance needed).

## Issue #65 status: pure core + reader + role-resolution done; UI + live wiring open

Landed so far (pure/testable, per repo convention — no live send path yet):
- `parseUploadedColumns` (retain every column) + `readUploadedColumnsFromFile`.
- `materialiseRecipients` (tracking-key identity + variables bag + single-invoice
  hard gate).
- `campaigns.columnRoles` schema field (persist roles by header).
- **`resolveColumnRoles`** (this iteration) — header-roles → index `ColumnRoles`.

**Still open on #65:**
- **AC #2 / #3 — operator UI**: surface headers + role-designation dropdowns in
  `UploadListPanel.tsx` (extends the #54 `ColumnChooser` pattern). ⚠️ **Not
  RGR-testable in this repo** — there is no React test infra (no jsdom /
  testing-library; vitest runs under the `node` env, all tests are pure-logic /
  faked-ctx). A UI-only slice can't be driven test-first here.
- **AC #5 — end-to-end integration**: route uploaded rows through *materialised
  recipients* (variables bag + tracking-key identity) instead of the current
  `{ contactIds }` → **Dynamics re-resolution** at send time. This rewrites
  `startCampaign` / `campaignQueue.processCampaignFilters` and **overlaps #66**
  (merge consuming the bag) and **#67** (validation report) — those slices define
  the merge + validation contract, so the wiring is best done alongside them. The
  `campaignBatches.recipients` shape already carries `id` + `variables`, so the
  batch layer is ready to receive materialised recipients.

## PRD #55 status: seam work COMPLETE (#56–#63)

All eight seam slices are done and committed. PRD parents **#55** and **#48**
remain open but are docs/tracking, not agent work. No remaining agent work
queued for PRD #55.

## Dependency chain (bad-debt PRD) — what's unblocked

- **#65** — unblocked, partially done (this chain's root). Remaining = UI + wiring.
- #66 (merge) blocked by #65 · #67 (validation) blocked by #66 · #68 (PDF pre-gen)
  blocked by #65 · #69/#70 blocked by #66/#68 · #71 blocked by #67/#69.
- Once #65's live wiring lands, #66 and #68 open up.

## ⚠️ Outstanding uncommitted WIP — NOT mine, leave it alone

The working tree still carries an unrelated, in-progress **`delivered = sent`
redefinition** that is not part of any closed issue. Do **not** commit or revert
it unless you own it:
- `convex/lib/campaignTally.ts`, `convex/lib/__tests__/campaignTally.test.ts`,
  `convex/messages.ts`, `convex/backfill.ts` (`recomputeAllCampaignStats`),
  `.sandcastle/prompt.md`, `convex/_generated/api.d.ts` (codegen drift),
  untracked `docs/email-template-design-research.md`.

⚠️ That WIP makes **3 tests fail** in `recomputeCampaignStats.test.ts` (bounce ⇒
delivered/failed counts). **Confirmed pre-existing** — do not attribute them to
your slice. If you commit only your own files, your slice is green on its own.

## Environment / gotchas
- `node_modules` installed. Test runner is **vitest 4** via `npm run test` (or
  `npx vitest run <path>` for one file), **`node`** environment.
- **No React test infra** — UI components can't be RGR-tested; keep slices at the
  pure-logic / faked-ctx layer.
- Mutations tested via extracted `Impl` fns + a faked `ctx.db` (query→withIndex→eq
  chain + `patch`/`insert`), not `convex-test`.
- Pure recipient logic lives in `src/components/recipients/columnRoles.ts`
  (retain/materialise/**resolve**) — the test surface, prior art the same suite.

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` before committing — the 3
  `recomputeCampaignStats` failures are a known pre-existing exception.
- Keep the commit scoped to your own files while the `delivered = sent` WIP sits
  uncommitted.
- Single commit, `RALPH:` prefix, list decisions/files/blockers.
- **Rewrite this `handoff.md` when the next issue's slice is done.**
