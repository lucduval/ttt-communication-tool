# Handoff — RALPH iteration

## Just completed: #35 — Contact Query: retire the raw OData filter passthrough

**Issue #35 closed.** Branch: `main`. Commit `4104a64`.

Last slice of the Contact Query sub-chain (#32–#35). With marketing-type (#32),
the opt-in flags (#33), and channel-eligibility (#34) all promoted to typed
dimensions, nothing legitimate rode the raw `filter` escape hatch any more — so
this slice **deleted it**. "Contact Query is the only author of the OData dialect"
is now structurally enforced rather than documented: the client emits no OData,
and the recipient count + the send resolve from one typed filter that cannot drift.

**Removal characterization (decision):** rather than deleting the old
"wraps a raw passthrough filter" test, it was rewritten to pin the *removal* —
`buildContactFilter({ filter } as ContactFilter)` now returns just the active-only
base (the stray raw string contributes nothing). This is the red→green that proves
the escape hatch no longer concatenates anything.

Changes by layer:
- **`convex/lib/contactQuery.ts`** (the deep place): deleted `ContactFilter.filter`
  and the leading ` and (${filter.filter})` clause in `buildContactFilterClauses`.
- **`convex/lib/dynamics_util.ts`** (send path): dropped `filter` from
  `CampaignFilters` and `toContactFilter`.
- **`convex/actions/dynamics.ts`**: removed the `filter: v.optional(v.string())`
  validator from all 7 filter-taking actions; removed the `filter` destructure +
  pass in the 3 facades (`fetchContacts`, `getContactCount`, `fetchAllContactIds`).
  The 4 specialised actions rode it via `resolvedArgs` — now simply absent.
- **`src/components/filters/ContactFilters.tsx`**: deleted `buildODataFilter()`
  (it only ever returned `undefined` after #32–#34); replaced with a note recording
  why the client emits no OData.
- **`src/components/filters/index.ts`**: stopped re-exporting `buildODataFilter`.
- **`src/app/recipients/page.tsx`**: dropped the `buildODataFilter` import and its
  3 call sites (the `filter: odataFilter` args were always `undefined`).
- **`src/app/campaigns/new/page.tsx`**: dropped the `filter: f.filter` straggler in
  `fetchSampleContacts`; refreshed the stale "channel baked into filter" comment.
- **`convex/lib/__tests__/contactQuery.test.ts`**: characterized the removal; dropped
  the `filter` key from the two characterization spreads + the base-equals-clauses test.

**Verification:** `npm run typecheck` clean; `npm run test` = 1460 passed
(worktree-duplicated copies inflate older counts).

**Outstanding (HITL, not closeable by the unit suite):** #35's last acceptance item
asks for one live Dynamics query confirming a select-all count equals the resolved
send recipient count before rollout. That needs a human against the live org.

## Next up: #45 — Campaign Tally pure module + detail view aligned

New chain (PRD #44 — Campaign Tally: single source of truth for campaign delivery
stats; slices #45 → #46 → #47). **#45 is unblocked** ("can start immediately").

> ⚠️ **Pre-existing uncommitted working-tree changes** (present at the start of the
> #35 session, NOT part of #35, left untouched): `CONTEXT.md` already has a
> "Reporting / Campaign Tally" section describing `convex/lib/campaignTally.ts`
> **as if it exists** (it does not yet — it's #45's deliverable), and
> `convex/_generated/api.d.ts` has an uncommitted `lib/batchLease` registration.
> Decide whether to fold these into the #45 commit or discard — don't be surprised
> by them. The CONTEXT.md text is a usable spec for the module you're about to build.

Acceptance (see `gh issue view 45` for full text):
- New **pure** module `convex/lib/campaignTally.ts`: a function over a campaign's
  per-recipient message statuses returning `{ sent, delivered, failed, pending }`.
  No `ctx`, no db access — takes statuses, returns counts.
  - `sent` = `sent` **plus** `delivered` (successfully handed to provider)
  - `delivered` = `delivered` only
  - `failed` = `failed`; `pending` = `pending`
  - empty input → all zeros; unknown statuses handled deterministically.
- Rewire `getCampaignStats` to recount via the shared tally; delete its inline
  `sent + delivered` arithmetic so detail and (later) list use identical logic.
- No schema changes; detail-page numbers unchanged (pure refactor of the recount).

### Pointers
- The query to rewire is **`convex/messages.ts::getCampaignStats`** (lines ~46–78).
  It currently counts each status via the `by_campaign_status` index and returns
  `sent: sent + delivered` inline (line ~72). After: collect the campaign's message
  statuses, hand them to the tally, return its `{ sent, delivered, failed, pending }`
  (keep `total: campaign.totalRecipients`).
- The tally takes **statuses** (e.g. `string[]` or a status→count map), not rows /
  not `ctx`. Keep it dependency-free so it's the one seam #46/#47 also call.
- **Prior art for the pure-module + test shape: `convex/lib/batchLease.ts` +
  `convex/lib/__tests__/batchLease.test.ts`.** Mirror that structure.
- Two callers read `getCampaignStats` (don't change their shape): the campaign
  detail page `src/app/campaigns/[id]/page.tsx` and
  `src/components/campaigns/BouncedEmailsCard.tsx`.

### Campaign Tally area notes
- The `messages` table is the **source of truth**; each recipient's status is written
  idempotently. The tally is a pure function over those statuses.
- #46 (next, blocked by #45) introduces `recomputeCampaignStats(ctx, campaignId)` that
  **sets** (never `+=`) the campaign-document counters `sentCount` / `deliveredCount`
  / `failedCount` from the same tally, at every batch settle + bounce, and stops the
  recovery sweep from writing counts. #47 is a one-time backfill migration over all
  campaigns. So #45's tally is the shared seam both later slices depend on — design it
  to take a plain status collection, not a query result.
- The `by_campaign_status` compound index is the read path for a campaign's messages
  (see `convex/messages.ts` and `convex/campaignBatches.ts`).

## Workflow reminders (RALPH)
- One issue per iteration. RGR: failing test first, then implementation.
- `npm run typecheck` + `npm run test` must pass before committing.
- Single commit, `RALPH:` prefix, list decisions/files/blockers. Keep the commit
  scoped to the issue's files (don't sweep in unrelated working-tree changes).
- Close with `gh issue close <ID> --comment "Completed by Sandcastle…"`.
- **Update this `handoff.md` when the next issue is done, in the same fashion** —
  rewrite "Just completed" for the issue you finished, move "Next up" to the
  highest-priority unblocked issue with the same concrete pointers.
- Note: vitest also picks up copies under `.sandcastle/worktrees/**` — harmless
  duplication in the test counts, ignore it.
