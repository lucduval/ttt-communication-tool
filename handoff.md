# Handoff — RALPH iteration

## Just completed: #29 — migrate the tax-return (SARS reimbursement) audience

**Branch:** `sandcastle/contact-query`. Issue #29 to be closed.

Migrated the tax-return audience onto the Specialised Audience module (stood up in
#28) and deleted both hand-rolled tax-return pipelines.

What landed:
- **`taxReturnScanAdapter`** (`convex/lib/specialisedAudience.ts`): scans
  `new_invoiceses` for `ttt_sarsreimbursement ge threshold` within the target-year
  window (`createdon` ge/lt, `_ttt_customer_value ne null`, `statecode eq 1`) via
  Contact Query's `streamEntity` (paging/retry reused), and collapses to each
  contact's **highest reimbursement**. There is **no** in-memory membership test —
  the threshold *is* the scan query — so `contactIds` = all keys of the
  highest-per-contact figures map, and the scan figure is the reimbursement amount.
  `targetYear` is passed in resolved (caller owns the previous-year default), so the
  adapter is deterministic and testable.
- **Both consumers migrated; both hand-rolled tax-return pipelines deleted:**
  - List/preview `fetchContactsByTaxReturn` (`actions/dynamics.ts` ~line 777) is now
    the rich-list mapper around the resolver. `withTaxProfile` stays **unset** —
    this audience displays the reimbursement directly, read from
    `extra.scanFigure` into `sarsReimbursement` (no Tax Profile join).
  - Send `fetchMatchingContactsByTaxReturn` (`dynamics_util.ts` ~line 127) is now the
    slim send-shape mapper around the resolver. Its `dynamicsRequest` import and the
    `buildExtraContactFilter` helper (plus its `buildContactFilterClauses` import)
    were removed as dead code.
  Re-query routes through Contact Query's `contactIds` dimension; **no** `contactid
  eq` building survives in either tax-return path. Membership + highest-reimbursement
  selection are identical by construction, so the reviewed list and the sent audience
  match.

Tests: extended `convex/lib/__tests__/specialisedAudience.test.ts` with a
`taxReturnScanAdapter` describe block (highest-reimbursement collapse with
every-contact-qualifies, plus the threshold + year-window + statecode/customer
scan-clause invariant), driven through the injected `request` boundary.

**Verification:** `npm run typecheck` clean; `npm run test` = 1405 passed.

## Next up: #30 — migrate the bad-debt + referral audiences

#30 is now **unblocked** (it was blocked by #29). Highest-priority remaining.

Scope (see #30 body for full acceptance criteria):
- Route the **bad-debt** and **referral** audiences through the shared resolver and
  delete their hand-rolled pipelines, ending with **no `contactid eq` id-clause
  building anywhere outside Contact Query**.

### Pointers for #30
- Hand-rolled pipelines / `contactid eq` chunking still to replace
  (`convex/actions/dynamics.ts`):
  - `fetchContactsByBadDebt` action (~line 1086), `contactid eq` chunking ~line 1184.
  - `fetchReferralParticipants` action (~line 1232), `contactid eq` chunking ~line 1311.
  - These are the **last two** `contactid eq` sites in the repo — grep
    `contactid eq` across `actions/dynamics.ts` + `dynamics_util.ts` should return
    nothing once #30 lands.
- Note the send paths: `dynamics_util.ts` currently has **no** bad-debt/referral send
  function (only `fetchMatchingContacts`, `…ByTaxReturn`, `…WithITA34`). Confirm how
  each of these audiences actually sends before deleting — they may resolve list-only,
  or the send may route differently. Map this first.
- **Adapter pattern to copy:** `taxReturnScanAdapter` is the closest model — like
  tax-return, these are reimbursement/threshold-style audiences whose displayed value
  is the scan figure, so `withTaxProfile` stays unset and the mapper reads
  `extra.scanFigure`. If an audience needs no membership test, `contactIds` = all keys
  of the figures map (as in tax-return). Inspect each pipeline's collapse rule before
  copying — bad-debt and referral may differ.
- Tests: the `specialisedAudience.test.ts` patterns (injected `request`, routed-by-
  endpoint fake, scan-clause + collapse assertions) are the model.

## After #30
- End-state goal reached when **no `contactid eq` id-clause building survives outside
  Contact Query** — verify across `actions/dynamics.ts` and `dynamics_util.ts`
  (after #28 ITA34's are gone, after #29 tax-return's are gone, after #30 bad-debt +
  referral's are gone → repo-wide grep for `contactid eq` outside Contact Query is
  empty).

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing.
- Single commit, `RALPH:` prefix, list decisions/files/blockers.
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Update this `handoff.md` when the next issue is done, in the same fashion** —
  rewrite "Just completed" for the issue you finished, move "Next up" to the
  highest-priority unblocked issue with the same concrete pointers, refresh "After".
- Note: vitest also picks up copies under `.sandcastle/worktrees/**` — harmless
  duplication in the test counts, ignore it.
