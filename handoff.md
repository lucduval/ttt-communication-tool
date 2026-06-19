# Handoff — RALPH iteration

## Just completed: #32 — Contact Query: type the marketing-type filter as a dimension

**Issue #32 closed.** Branch: `main`.

First of the Contact Query sub-chain (#32–#35) that retires the raw-OData escape
hatch one dimension at a time. Promoted **marketing type** (tax / accounting /
insurance) from a client-built OData string to a **typed Campaign-filter dimension
owned by Contact Query**. Previously it lived only as OData emitted by the client's
`buildODataFilter()` (`riivo_taxmarketing eq true`, etc.) and rode through the raw
`filter` passthrough on both count and send.

Now a single typed `marketingType` value flows UI → action → Contact Query, and
Contact Query owns the `riivo_*marketing` field names — the client emits no
marketing OData. `"all"` has no typed representation (simply absent → no clause).

Changes by layer:
- **`convex/lib/contactQuery.ts`** (the deep place): added `marketingType?: "tax" |
  "accounting" | "insurance"` to `ContactFilter`; `buildContactFilterClauses` emits
  ` and <field> eq true` via a private `MARKETING_TYPE_FIELD` map (the only place the
  `riivo_*marketing` names live). Clause is positioned after `industryId`, before the
  name-range bounds.
- **`convex/lib/dynamics_util.ts`** (send path): added `marketingType` to
  `CampaignFilters` and mapped it in `toContactFilter`, so the send-time stream and
  all specialised-audience sends resolve it from the same typed value as count.
- **`convex/actions/dynamics.ts`**: added the `marketingType` validator
  (`v.union(v.literal(...))`) to all 7 filter-taking actions. The 3 facades
  (`fetchContacts`, `getContactCount`, `fetchAllContactIds`) destructure + pass it
  into the `ContactFilter`; the 4 specialised actions already spread `resolvedArgs`
  as the filter, so it threads through automatically.
- **`src/components/filters/ContactFilters.tsx`**: removed the marketing block from
  `buildODataFilter()` (left a note mirroring the name-range one). The client no
  longer hand-builds `riivo_*marketing`.
- **`src/app/recipients/page.tsx`** + **`src/app/campaigns/new/page.tsx`**: every
  filter call site now passes `marketingType: filters.marketingType !== "all" ?
  filters.marketingType : undefined`, including the persisted `campaignFilters`
  payload (so count and send agree) and the `fetchSampleContacts` re-resolve.
- **`convex/lib/__tests__/contactQuery.test.ts`** (+4 tests): each marketing type
  emits its clause; the "all" (absent) case emits none; the extra-filter
  characterization spread now pins marketing's clause ordering.

**Verification:** `npm run typecheck` clean; `npm run test` = 1449 passed (+4).

## Next up: #33 — Contact Query: type the opt-in flags (WhatsApp opt-in, email-enabled)

The exact same move as #32, one rung further. Promote the **opt-in flags** —
WhatsApp opt-in (`riivo_whatsappoptinout`) and email-enabled
(`icon_sendemailclientnotifications`) — from client-built OData to **typed,
tri-state (true / false / unset) Campaign-filter dimensions owned by Contact
Query**. They still live in `buildODataFilter()` and ride the raw `filter`
passthrough today.

Acceptance (see `gh issue view 33` for full text):
- Both flags are typed fields on the Campaign filter from the UI through to Contact
  Query; Contact Query emits both clauses; the field names appear only inside Contact
  Query.
- "Unset" emits no clause; true/false emit the matching equality.
- Count and send agree; unit tests cover true / false / unset for each flag.

### Pointers (follow the #32 pattern exactly — it's the template)
- **Tri-state**, not 2-state: the typed field is `boolean | undefined`. `undefined`
  (= UI "all"/null) emits no clause; `true`/`false` emit `<field> eq true|false`.
  Mind that `if (filter.x)` would drop `false` — gate on `!== undefined`.
- `convex/lib/contactQuery.ts`: add `whatsappOptIn?: boolean` and `emailEnabled?:
  boolean` to `ContactFilter`; emit in `buildContactFilterClauses` (the
  `icon_sendemailclientnotifications` / `riivo_whatsappoptinout` names live only
  here). Add the each-state unit tests in `__tests__/contactQuery.test.ts`.
- `convex/lib/dynamics_util.ts`: add both to `CampaignFilters` + `toContactFilter`.
- `convex/actions/dynamics.ts`: add `v.optional(v.boolean())` validators to the 7
  filter-taking actions; destructure + pass on the 3 facades (specialised ones ride
  `resolvedArgs`).
- `src/components/filters/ContactFilters.tsx`: drop the `whatsappOptIn` /
  `emailEnabled` blocks from `buildODataFilter()`. Note the UI already holds these as
  `filters.whatsappOptIn` / `filters.emailEnabled` (`boolean | null`) — map `null →
  undefined` at the call sites in both pages and the persisted `campaignFilters`.
- **Watch the channel clause.** `getChannelFilter()` in `campaigns/new/page.tsx`
  hard-codes `riivo_whatsappoptinout eq true` into the WhatsApp channel filter string
  (separate from the user-facing opt-in filter). That's channel eligibility (#34's
  territory), not the user's opt-in dimension — don't double-emit. #33 should leave
  the channel clause alone; #34 composes channel-eligibility with #33's flag without
  emitting it twice. #33 before #34 is the cleaner order.

### Then
- **#34** (channel-eligibility) — overlaps #33's WhatsApp flag; compose without
  double-emitting.
- **#35** (do last; blocked by #32/#33/#34) — removes `ContactFilter.filter` /
  `CampaignFilters.filter`, deletes `buildODataFilter()` and the raw clause in
  `getChannelFilter()`, and routes count + send through one typed filter so they
  can't drift. With #32 done, marketing is no longer in the passthrough; #35 can
  retire it once the remaining dimensions (opt-ins, channel) are typed too.

### Contact Query area notes
- The pure clause-builder is **`convex/lib/contactQuery.ts`**. Each typed dimension is
  one `if` in `buildContactFilterClauses` plus an interface field; the active-only
  base + clause ordering are pinned by the characterization tests.
- **Registered Convex mutations don't expose `.handler`** for unit tests. The
  established pattern (`runChannelSend`, `recoverStuckBatchesImpl`) is a plain
  exported `fooImpl(ctx, now = Date.now)` the registered wrapper delegates to.
- The send path: stored campaign filters are `JSON.parse`d into `CampaignFilters` in
  `convex/campaignQueue.ts::processCampaignFilters`, then `toContactFilter` maps them.
  Any new typed dimension must be added to both `CampaignFilters` and `toContactFilter`
  or the send will silently drop it.

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
