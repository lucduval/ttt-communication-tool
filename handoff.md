# Handoff — RALPH iteration

## Just completed: #33 — Contact Query: type the opt-in flags (WhatsApp opt-in, email-enabled)

**Issue #33 closed.** Branch: `main`.

Second of the Contact Query sub-chain (#32–#35). Promoted the **opt-in flags** —
WhatsApp opt-in (`riivo_whatsappoptinout`) and email-enabled
(`icon_sendemailclientnotifications`) — from client-built OData to **typed,
tri-state (true / false / unset) Campaign-filter dimensions owned by Contact
Query**. Previously they lived only as OData emitted by the client's
`buildODataFilter()` and rode through the raw `filter` passthrough on count and send.

Now typed `whatsappOptIn` / `emailEnabled` booleans flow UI → action → Contact
Query, which owns the field names — the client emits no opt-in OData. **Tri-state:**
`undefined` (= UI "all"/`null`) emits no clause; `true`/`false` emit `<field> eq
true|false`. The clause builders gate on `!== undefined` so an explicit `false` is
not dropped.

Changes by layer (the #32 marketing-type move, one rung further):
- **`convex/lib/contactQuery.ts`** (the deep place): added `whatsappOptIn?: boolean`
  and `emailEnabled?: boolean` to `ContactFilter`; `buildContactFilterClauses` emits
  ` and riivo_whatsappoptinout eq <bool>` / ` and icon_sendemailclientnotifications
  eq <bool>` (the only place those field names live), positioned after
  `marketingType`, before the name-range bounds. Gated on `!== undefined`.
- **`convex/lib/dynamics_util.ts`** (send path): added both to `CampaignFilters` and
  mapped them in `toContactFilter`, so the send-time stream and all
  specialised-audience sends resolve them from the same typed values as count.
- **`convex/actions/dynamics.ts`**: added `v.optional(v.boolean())` validators for
  both flags to all 7 filter-taking actions. The 3 facades (`fetchContacts`,
  `getContactCount`, `fetchAllContactIds`) destructure + pass them; the 4 specialised
  actions ride `resolvedArgs` so they thread through automatically.
- **`src/components/filters/ContactFilters.tsx`**: removed the `whatsappOptIn` /
  `emailEnabled` blocks from `buildODataFilter()` (left a note, and a reminder that
  channel-eligibility's hard-coded WhatsApp clause is a separate concern). The client
  no longer hand-builds opt-in OData.
- **`src/app/recipients/page.tsx`** + **`src/app/campaigns/new/page.tsx`**: every
  filter call site now passes `whatsappOptIn: filters.whatsappOptIn ?? undefined`
  and `emailEnabled: filters.emailEnabled ?? undefined` (mapping `null → undefined`),
  including the persisted `campaignFilters` payload (so count and send agree) and the
  `fetchSampleContacts` re-resolve.
- **`convex/lib/__tests__/contactQuery.test.ts`** (+6 tests): true / false / unset
  for each flag; the extra-filter characterization spread now pins both clauses'
  ordering (after marketing, before name range).

**Note on the channel clause (left untouched on purpose):** `getChannelFilter()` in
`campaigns/new/page.tsx` still hard-codes `riivo_whatsappoptinout eq true` into the
WhatsApp channel filter string. That's channel eligibility (#34's territory), not the
user-facing opt-in dimension. When a WhatsApp campaign also sets `whatsappOptIn=true`,
both emit `riivo_whatsappoptinout eq true` — harmless (idempotent) for now; #34
composes them without double-emitting.

**Verification:** `npm run typecheck` clean; `npm run test` = 1455 passed (+6).

## Next up: #34 — Contact Query: type channel-eligibility as a reachability dimension

The same move, on the channel-eligibility clause. Today `getChannelFilter()` in
`campaigns/new/page.tsx` hand-builds the raw OData: `emailaddress1 ne null` for
email/personalised, and `(mobilephone ne null or icon_formattedmobilenumber ne null)
and riivo_whatsappoptinout eq true` for WhatsApp — then concatenates it onto the rest
via the `filter` passthrough.

Acceptance (see `gh issue view 34` for full text):
- `ContactFilter` expresses channel reachability as a typed dimension; Contact Query
  builds the email-reachable and whatsapp-reachable clauses; the field names live
  only inside Contact Query.
- The client no longer hand-builds channel-eligibility OData (`getChannelFilter()`'s
  raw clause is gone).
- Count and send apply the same reachability clause for a given channel.
- Reachability composes cleanly with #33's WhatsApp opt-in — **no duplicated
  `riivo_whatsappoptinout` clause**.
- Unit tests cover email reachability, whatsapp reachability, and the
  compose-with-opt-in case.

### Pointers (follow the #32 / #33 pattern)
- `convex/lib/contactQuery.ts`: add a typed reachability dimension to `ContactFilter`
  — likely `reachableChannel?: "email" | "whatsapp"` (the campaign channel maps
  personalised → email). Emit in `buildContactFilterClauses`:
  - email → `emailaddress1 ne null`
  - whatsapp → `(mobilephone ne null or icon_formattedmobilenumber ne null) and
    riivo_whatsappoptinout eq true`
  The `emailaddress1` / `mobilephone` / `icon_formattedmobilenumber` /
  `riivo_whatsappoptinout` names should live only here.
- **Compose with #33 without double-emitting.** The whatsapp reachability clause
  already includes `riivo_whatsappoptinout eq true`. If the caller also set the
  typed `whatsappOptIn` dimension, don't emit `riivo_whatsappoptinout` twice. Cleanest
  fix: when `reachableChannel === "whatsapp"`, have the reachability clause carry the
  presence check (`mobilephone`/`icon_formattedmobilenumber ne null`) and let the
  existing `whatsappOptIn` dimension own the `eq true` — i.e. set `whatsappOptIn=true`
  for WhatsApp campaigns instead of baking it into the reachability clause. Decide and
  pin it with the compose-test.
- `convex/lib/dynamics_util.ts`: add the reachability dimension to `CampaignFilters` +
  `toContactFilter` (the send path needs the campaign channel too — check how
  `processCampaignFilters` / the stored `campaignFilters.filter` carries channel
  today; the channel clause is currently baked into the persisted `filter` string).
- `convex/actions/dynamics.ts`: add a validator to the 7 filter-taking actions;
  facades destructure + pass, specialised ride `resolvedArgs`.
- `src/app/campaigns/new/page.tsx`: replace `getChannelFilter()`'s raw clause with
  the typed dimension at every call site (it's threaded through ~7 call sites + the
  persisted `campaignFilters`). `recipients/page.tsx` has no channel concept (it lists
  all contacts), so it likely passes no reachability dimension.

### Then
- **#35** (do last; blocked by #32/#33/#34) — removes `ContactFilter.filter` /
  `CampaignFilters.filter`, deletes `buildODataFilter()` and the raw clause in
  `getChannelFilter()`, and routes count + send through one typed filter so they
  can't drift. With #32 + #33 done, marketing and the opt-ins are out of the
  passthrough; #35 can retire it once channel (#34) is typed too.

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
