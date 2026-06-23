# Handoff — RALPH iteration

## Just completed: #54 — Manual column choice for ambiguous files

**Issue #54 closed.** Branch: `main`. Commit `9af89eb`.

Sixth (and final sub-) slice of PRD #48. #52 left an `ambiguous` status +
`candidates[]` contract but no way to act on it — detection dead-ended at a red
error. This slice gives the user a column-choice dropdown so detection never
silently guesses and the user resolves ambiguity without re-shaping the file.

Changes (all in `src/components/recipients/`):
- **`extractContactIds.ts`**: new pure **`extractContactIdsForColumn(rows,
  columnIndex)`** — bypasses the tier 1→2→3 detection and runs the chosen column
  straight through the same `collect()` validate/dedupe/skip loop, so a
  hand-picked column behaves identically to a detected one. Empty file → `empty`.
- **`readContactIds.ts`**: factored the impure byte-read into a shared
  **`readRows(file)`** (CSV/XLSX format detection now in one place); added
  **`extractContactIdsForColumnFromFile(file, columnIndex)`** twin that re-reads
  the file (deterministic re-parse → same indices) and delegates to the pure fn.
- **`UploadListPanel.tsx`**: holds the ambiguous file + `candidates` in local
  `chooser` state; renders a **`ColumnChooser`** dropdown only when status is
  `ambiguous` (never for auto-detected tier 1–3 files). Picking a column
  re-extracts and feeds the result back through the **same `onResult` seam**, so
  it activates the `{ contactIds }` filtered selection with the same count/skip
  summary as auto-detection. The chooser stays visible after a pick so a wrong
  choice can be re-picked. `errorMessage` simplified (ambiguous no longer reaches
  `UploadStatus`).
- **`index.ts`**: export the new pure/impure twins + `DetectedColumn` type.
- **Tests**: 7 new — 5 pure (`extractContactIdsForColumn`: chosen column over
  ambiguous tiers / dedupe+skip / header trim / no-ids column / empty) + 2 impure
  (`extractContactIdsForColumnFromFile`: re-read + chosen column / skip summary).

**Verification:** `npm run typecheck` clean; `npm test -- run` = **359 passed**
(7 new).

### Gotchas / decisions
- **Re-read, not retain.** A manual pick re-reads the file via `readRows` rather
  than threading parsed rows through React state. The parse is deterministic, so
  the chosen index lines up with the original `candidates` indices. Files are
  small (id-source only), so the double-parse is cheap and the panel stays thin.
- **Same `onResult` seam.** A manual choice produces a normal `ok`
  `ContactIdExtraction` and goes through the exact `onResult` → `handleUploadResult`
  → `activateFiltered` path as auto-detection. Nothing on the page changed.
- **`candidates` come straight from #52.** The dropdown lists `result.candidates`
  (GUID-shaped columns when any exist, else every column — never empty), so the
  chooser is always populated. Blank header cells fall back to `Column N` labels.
- **Chooser is panel-local.** It lives in `UploadListPanel`, which only mounts for
  `audience === "upload"`, so switching audience unmounts it and clears the state.
  A fresh drop resets it in `handleFile`.

## PRD #48 status: all sub-slices done (#49–#54)

`gh issue list` shows **no open sub-issues** under PRD #48 — only the parent **#48**
itself is open. The four-tier extraction (explicit `contactid` → Dynamics
`(Do Not Modify)` → GUID auto-detect → **manual column choice**), `toContactFilter`
`contactIds`, the page-fetch/count path, the Upload-list UI, and the XLSX dep are
all in. **The parent #48 likely needs a human verification pass + close**, not
another agent slice — confirm before grabbing it as work.

## Next up
- No unblocked sub-issue remains. Re-check `gh issue list` for newly-filed work,
  or surface #48 for human sign-off.

## Environment / gotchas
- `node_modules` is installed. `vitest` is not on PATH; use **`npm test -- run <path>`**
  (or `npm test -- run` for all).
- vitest runs under the **`node`** environment (not jsdom). `File` + `.text()` are
  Node globals there, so the impure file-reader tests work without a DOM shim.
- Pre-existing lint error in `page.tsx` (`react/no-unescaped-entities`) is **not ours** —
  lint is not in the RALPH gate (typecheck + test only). Leave it.
- Working tree still carries **pre-existing unrelated** uncommitted changes
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
