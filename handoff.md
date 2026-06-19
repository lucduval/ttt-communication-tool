# Handoff — RALPH iteration

## Just completed: #30 — migrate the bad-debt + referral audiences

**Branch:** `sandcastle/contact-query`. Issue #30 to be closed.

Migrated the last two specialised audiences (bad-debt, referral) onto the shared
resolver and deleted both hand-rolled pipelines. **This was the final slice: no
`contactid eq` id-clause building survives outside Contact Query anywhere in the
repo.**

What landed:
- **`badDebtScanAdapter`** (`convex/lib/specialisedAudience.ts`): scans
  `new_invoiceses` for open invoices (`statecode eq 0`, `statuscode eq 958140000`,
  `ttt_outstanding gt 0`, `_ttt_customer_value ne null`) via `streamEntity`, and
  collapses to each contact's **highest outstanding** amount. Like tax-return there
  is **no** membership test — the open-invoice predicate *is* the scan query — so
  `contactIds` = all keys of the highest-per-contact map and the scan figure is the
  outstanding amount.
- **`referralScanAdapter`** (`convex/lib/specialisedAudience.ts`): scans `contacts`
  for `_riivo_referredby_value ne null` and collects the **distinct referrer-id
  set**. No membership test and **no per-contact figure** — `contactIds` = the
  distinct set, `figures` is empty (resolver joins null). Inactive / non-contactable
  referrers fall away on the resolver's re-query (`statecode eq 0` + channel filter),
  exactly as before.
- **Both consumers migrated; both hand-rolled pipelines deleted** (`actions/dynamics.ts`):
  - `fetchContactsByBadDebt` is now the rich-list mapper around the resolver.
    `withTaxProfile` stays **unset** — it displays the outstanding amount directly,
    read from `extra.scanFigure` into `outstandingAmount`.
  - `fetchReferralParticipants` is now the rich-list mapper around the resolver. No
    figure displayed.
  - The now-dead `buildContactFilterClauses` import was removed from
    `actions/dynamics.ts` (the helper still lives + is tested in `contactQuery.ts`).
- **Send paths:** bad-debt and referral are **list-only / client-side-mode**
  audiences — the frontend (`campaigns/new/page.tsx`, `isClientSideMode`) fetches the
  full matching set via these actions into `allFilteredContactsRef` and sends it as an
  **explicit recipient list**. They never route through the filter-based send path in
  `campaignQueue.ts` (which only branches tax-return / ITA34 / default), so there is
  **no** `dynamics_util.ts` send function to migrate or delete. List = sent audience
  by construction, since the same resolved list is what gets sent.

Tests: extended `convex/lib/__tests__/specialisedAudience.test.ts` with
`badDebtScanAdapter` (highest-outstanding collapse + open-invoice scan-clause
invariant) and `referralScanAdapter` (distinct referrer-set collapse + nulls skipped
+ contacts scan-clause) describe blocks, driven through the injected `request`
boundary.

**Verification:** `npm run typecheck` clean; `npm run test` = 1409 passed.
Repo-wide grep for `contactid eq` outside Contact Query returns only the explanatory
comment in `specialisedAudience.ts` — no clause building.

## Next up: nothing queued

#30 was the only open `ready-for-agent` issue, and the Specialised Audience
migration end-state is now **reached**: every specialised audience (income / ITA34,
tax-return, bad-debt, referral) resolves through the shared resolver, and `contactid
eq` id-clause building lives **only** in Contact Query. No follow-up issue is open —
wait for the next issue to be filed/triaged before continuing.

### If picking up new work in this area
- The four adapters in `convex/lib/specialisedAudience.ts` are the reference pattern:
  `ita34IncomeScanAdapter` (membership test + Tax Profile join), and
  `taxReturnScanAdapter` / `badDebtScanAdapter` / `referralScanAdapter`
  (membership-free, displayed value = scan figure or none).
- Tests: the `specialisedAudience.test.ts` patterns (injected `request`, routed-by-
  endpoint fake, scan-clause + collapse assertions) are the model.

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
