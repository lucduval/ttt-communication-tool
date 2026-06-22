# Handoff — RALPH iteration

## Just completed: #50 — "Upload list" audience mode (happy-path CSV)

**Issue #50 closed.** Branch: `main`.

Second slice of PRD #48. Adds **Upload list** as a fourth audience mode on the
campaign Recipients step. The user drops a CSV with a `contactid` column; the
app parses it, validates + dedupes the GUIDs client-side, and activates the same
**filtered** Recipient Selection carrying `{ contactIds }` that #49 wired through
the send path — so an uploaded-list campaign is indistinguishable from any other
filtered campaign downstream.

Changes (all scoped to `src/components/recipients/` + the new-campaign page):
- **`extractContactIds.ts`** (new, pure): rows → `{ status, idColumn, contactIds,
  skippedRows, candidates }`. **Tier-1 detection only** (explicit `contactid`
  header, case-insensitive/trimmed). GUID-validated, brace/case-normalised,
  deduped in first-seen order; blank/malformed rows counted as `skippedRows`;
  duplicates collapsed (not skipped). Statuses: `ok` / `empty` / `no-column` /
  `ambiguous` (two `contactid` cols → deferred to #54).
- **`readContactIds.ts`** (new): pure `parseCsv` (quotes, CRLF, BOM, blank-line
  drop) + thin impure `readContactIdsFromFile(file)` wrapper.
- **`UploadListPanel.tsx`** (new): dropzone + parse + success/error status. Shows
  valid-id count, skipped-row count, and the "final total confirmed at send"
  message; clear error when no ids are detectable.
- **`extractContactIds.test.ts`** (17) + **`readContactIds.test.ts`** (7): new,
  table-driven.
- **`index.ts`**: re-exports the above.
- **`src/app/campaigns/new/page.tsx`**: 4th audience button; renders the panel in
  place of the filter panel; `loadContacts` early-returns for upload (no CRM
  fetch); a successful parse calls `activateFiltered({ contactIds }, count)`;
  audience-change effect clears the uploaded selection; ContactList/footer hidden
  in upload mode. **Guard added in `fetchSampleContacts`**: a `{ contactIds }`
  filter returns an empty sample (don't fetch arbitrary unfiltered contacts) —
  the real resolved preview is #53.

**Verification:** `npm run typecheck` clean; `npm run test` = 326 passed (24 new).

## Next up: #51 — XLSX upload support

**#51 is now unblocked** (blocked only by #50). Smallest remaining slice and a
direct extension of the reader seam just built.

What to build:
- Add **SheetJS (`xlsx`)** as a dependency.
- Extend the **impure** reader (`readContactIds.ts`) so an `.xlsx` file is parsed
  into the same `string[][]` rows that feed `extractContactIds`. Branch on file
  type inside `readContactIdsFromFile` (or add a sibling) — CSV path stays as is.
- Make the dropzone accept `.xlsx` (update the `accept` attr in
  `UploadListPanel.tsx`).
- **Reuse everything else unchanged**: `extractContactIds`, dedup/skip handling,
  and the `activateFiltered({ contactIds })` wiring. This slice only teaches the
  reader to ingest XLSX bytes.

See `gh issue view 51` for the full acceptance list.

### Pointers (reuse, don't reinvent)
- The pure extraction core (`extractContactIds`) is format-agnostic — it takes
  rows, not a file. XLSX just needs `worksheet → string[][]` (e.g.
  `XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" })`), then
  feed that to `extractContactIds`.
- Impurity stays confined to `readContactIdsFromFile`; keep any new parsing
  helpers pure + testable where practical (note: `xlsx` reads from an ArrayBuffer,
  so the binary read is the only impure bit).
- Dropzone lives in `src/components/recipients/UploadListPanel.tsx`.

## Remaining PRD #48 slices (dependency order)
- #51 — XLSX upload  ← **next, unblocked**
- #52 — Smart id-column detection, tiers 2–3 (unblocked by #50)
- #53 — Resolved-contact preview sample (unblocked by #49 ✓, #50 ✓ — see the
  `fetchSampleContacts` guard left as the seam)
- #54 — Manual column choice for ambiguous files (blocked by #52; the
  `ambiguous` status + `candidates[]` are already emitted by `extractContactIds`)

## Environment / gotchas
- `node_modules` **was** installed this session. `vitest` is not on PATH; use
  **`npm test -- run <path>`** (or `npm test -- run` for all).
- Pre-existing lint error in `page.tsx` (`react/no-unescaped-entities` on the
  existing `"Select All"` validation copy) is **not mine** — lint is not in the
  RALPH gate (typecheck + test only). Leave it.
- Working tree carries **pre-existing unrelated** uncommitted changes
  (`convex/engagementAudit.ts`, `convex/lib/engagementTrust.ts` + test,
  `CONTEXT.md`, `convex/_generated/api.d.ts`, `.sandcastle/prompt.md`,
  `package-lock.json`). I committed **only my files**. Leave the others alone.

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing.
- Single commit, `RALPH:` prefix, list decisions/files/blockers. Keep the commit
  scoped to the issue's files.
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Rewrite this `handoff.md` when the next issue is done.**
