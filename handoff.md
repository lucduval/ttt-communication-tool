# Handoff — RALPH iteration

## Just completed: #28 — stand up Specialised Audience module + migrate ITA34

**Branch:** `sandcastle/contact-query`. Issue #28 to be closed.

Stood up `convex/lib/specialisedAudience.ts` — the deep place that turns a
related-entity audience into a stream of contacts — and proved it end-to-end by
migrating the income (ITA34) audience onto it across both consumers.

What landed:
- **`ScanAdapter` contract** (`scan(request) → { contactIds, figures }`): owns the
  only part that varies per audience — the related-entity query, the collapse to
  one row per contact, and the in-memory membership test. Handed the injected
  request primitive so the same adapter runs against the real boundary or a fake.
- **`resolveSpecialisedAudience` resolver**: runs the adapter's scan, then
  re-queries the scanned ids through Contact Query's **`contactIds` dimension**
  (`streamContacts({ ...filter, contactIds }, …)`) — it builds **no** `contactid eq`
  clauses itself. Joins each returned contact with its scan figure and, when
  `withTaxProfile` is set, its Tax Profile display data. Yields `{ contact, extra }`
  per streamed chunk; empty scan issues no contact request and fetches no profiles.
  `request` / `sleep` / `fetchTaxProfilesFn` are all injectable for tests.
- **`ita34IncomeScanAdapter`**: scans `riivo_ita34s` via Contact Query's
  `streamEntity` (paging/retry reused, not hand-rolled), groups rows per contact,
  collapses to latest year by **reusing `taxProfile.pickLatest`**, and tests the
  income range against that latest row in memory. Income range is deliberately
  **not** an OData clause (server-side it tests every year → send disagrees with
  list, the #25/#26 bug); retirement-fund + year filters stay server-side. Scan
  figure = latest-year income; displayed figure = taxable income via Tax Profile.
- **Both consumers migrated; both hand-rolled ITA34 pipelines deleted:**
  - List/preview `fetchContactsWithITA34` (`actions/dynamics.ts`) is now the
    rich-list mapper around the resolver (`withTaxProfile: true`).
  - Send `fetchMatchingContactsWithITA34` (`dynamics_util.ts`) is now the slim
    send-shape mapper (`withTaxProfile: false` — send displays no figure).
  Membership + latest-year selection are now identical by construction, so the
  list the advisor reviews and the audience that sends always match.

Tests: new `convex/lib/__tests__/specialisedAudience.test.ts` (adapter latest-year
collapse + income membership + no-income-clause invariant; resolver id-chunked
re-query, clause re-application, Tax Profile join, empty-scan short-circuit). The
existing send-path test now fakes the `dynamics_auth` boundary (the new chain
reaches Dynamics there, not via `actions/dynamics`).

**Verification:** `npm run typecheck` clean; `npm run test` = 1403 passed.

## Next up: #29 — migrate the tax-return (SARS reimbursement) audience

#29 is now **unblocked** (it was blocked by #28). Highest-priority remaining.

Scope (see #29 body for full acceptance criteria):
- Add a **tax-return scan adapter** to `specialisedAudience.ts`: scan
  `new_invoiceses` for `ttt_sarsreimbursement ge threshold` within the target-year
  window (`createdon` ge/lt, `_ttt_customer_value ne null`, `statecode eq 1`),
  collapse to each contact's **highest reimbursement**. **No** income-range
  membership — the threshold is the scan query itself. Displayed figure = the
  reimbursement amount (so this audience uses `extra.scanFigure`, not a Tax
  Profile join → `withTaxProfile` stays false).
- Route **both** paths through the resolver, then **delete** the two hand-rolled
  tax-return pipelines.

### Pointers for #29
- Hand-rolled tax-return pipelines to replace/delete:
  - `convex/lib/dynamics_util.ts` ~line 132 (`fetchMatchingContactsByTaxReturn`),
    with `contactid eq` chunking at ~line 171 (chunks of 500).
  - `convex/actions/dynamics.ts` — `fetchContactsByTaxReturn` action (~line 779
    after the #28 edit shrank the file), `contactid eq` chunking inside it.
- The resolver already supports a scan-figure-only audience: leave `withTaxProfile`
  unset and read `extra.scanFigure` in the mapper. The list shape carries
  `sarsReimbursement`; the send shape is the same slim `ShimmedContact`.
- Adapter pattern to copy: `ita34IncomeScanAdapter` in `specialisedAudience.ts`.
  Note this adapter has **no** in-memory membership filter — every collapsed
  contact qualifies — so `contactIds` = all keys of the highest-per-contact map.
- Existing tax-return test (if any) + the new `specialisedAudience.test.ts`
  patterns (injected `request`, routed-by-endpoint fake) are the model.

## After #29
- #30 (bad-debt + referral audiences) is blocked by #29. End-state goal: **no
  `contactid eq` id-clause building survives outside Contact Query** — verify
  across `actions/dynamics.ts` and `dynamics_util.ts` (after #28, ITA34's are gone;
  tax-return's remain for #29; bad-debt/referral for #30).

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
