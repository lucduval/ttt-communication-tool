# Handoff — RALPH iteration

## Just completed: #34 — Contact Query: type channel-eligibility as a reachability dimension

**Issue #34 closed.** Branch: `main`.

Third of the Contact Query sub-chain (#32–#35). Promoted **channel eligibility** —
"reachable by the campaign's channel" — from a client-built OData string concatenated
through the raw `filter` passthrough into a **typed `reachableChannel` dimension owned
by Contact Query**. Previously `getChannelFilter()` in `campaigns/new/page.tsx`
hand-built `emailaddress1 ne null` (email/personalised) or `(mobilephone ne null or
icon_formattedmobilenumber ne null) and riivo_whatsappoptinout eq true` (whatsapp) and
appended it via `filter`.

Now the client only selects the channel; Contact Query owns the eligibility OData.
`reachableChannel?: "email" | "whatsapp"` — email/personalised campaigns map to
`"email"`, whatsapp to `"whatsapp"`.

**Compose-without-double-emit decision (Approach B — self-contained + suppress):**
the whatsapp reachability clause is self-contained — it emits the phone-presence
disjunction **and** `riivo_whatsappoptinout eq true` itself. To avoid emitting the
opt-in field twice when a caller also sets the `whatsappOptIn` dimension, the
standalone `whatsappOptIn` clause is **suppressed when `reachableChannel === "whatsapp"`**
(gate: `whatsappOptIn !== undefined && reachableChannel !== "whatsapp"`). This
preserves today's behaviour — whatsapp campaigns always enforce opt-in regardless of
the UI opt-in filter — with the fewest call-site edits (the `whatsappOptIn:` lines
were left untouched). The compose-test pins exactly one `riivo_whatsappoptinout`.
(The handoff floated Approach A — presence-only reachability + force `whatsappOptIn=true`
at every call site — but that needed an override at ~8 sites and risked a silent
opt-in regression if one was missed; B keeps the channel logic entirely in Contact Query.)

Changes by layer:
- **`convex/lib/contactQuery.ts`** (the deep place): added `reachableChannel?: "email"
  | "whatsapp"` to `ContactFilter`; `buildContactFilterClauses` emits
  ` and emailaddress1 ne null` (email) or ` and (mobilephone ne null or
  icon_formattedmobilenumber ne null) and riivo_whatsappoptinout eq true` (whatsapp),
  positioned after the opt-in flags, before the name-range bounds. The `emailaddress1`
  / `mobilephone` / `icon_formattedmobilenumber` / `riivo_whatsappoptinout` names live
  only here. The standalone `whatsappOptIn` clause now also gates on
  `reachableChannel !== "whatsapp"`.
- **`convex/lib/dynamics_util.ts`** (send path): added `reachableChannel` to
  `CampaignFilters` and mapped it in `toContactFilter`.
- **`convex/campaignQueue.ts`** (`processCampaignFilters`): injects
  `reachableChannel = channel === "whatsapp" ? "whatsapp" : "email"` into
  `parsedFilters` from the campaign's own `channel` arg — **not persisted** in the
  stored filters, so count (client) and send can't drift. Threads through
  `fetchMatchingContacts` / `…ByTaxReturn` / `…WithITA34` via `toContactFilter`.
- **`convex/actions/dynamics.ts`**: added
  `v.optional(v.union(v.literal("email"), v.literal("whatsapp")))` to all 7
  filter-taking actions. The 3 facades destructure + pass it; the 4 specialised
  actions ride `resolvedArgs`.
- **`src/app/campaigns/new/page.tsx`**: replaced `getChannelFilter()` (deleted) with
  `getReachableChannel()` returning `"email" | "whatsapp"`; every contact call site
  now passes `reachableChannel` instead of `filter: channelFilter`. The persisted
  `campaignFilters` payload drops its channel `filter` (send injects reachability).
  Removed the now-unused `buildODataFilter` import.
- **`src/components/filters/ContactFilters.tsx`**: updated the `buildODataFilter` note
  to record that channel eligibility is now the typed `reachableChannel` dimension.
- **`convex/lib/__tests__/contactQuery.test.ts`** (+5 tests): email reachability,
  whatsapp reachability, unset, compose-with-opt-in (single field), and email-does-not-
  suppress-opt-in; the extra-filter characterization spread now pins `reachableChannel:
  "email"`'s position (after the opt-in flags, before name range).

**Verification:** `npm run typecheck` clean; `npm run test` = 1460 passed (+5;
worktree-duplicated copies inflate older counts).

## Next up: #35 — retire the raw `filter` passthrough (Contact Query single typed filter)

Last of the chain; now unblocked (#32/#33/#34 all done — marketing, opt-ins, and
channel are all typed, so nothing legitimate rides the passthrough any more).

Acceptance (see `gh issue view 35` for full text):
- Remove `ContactFilter.filter` / `CampaignFilters.filter` (the raw OData passthrough).
- Delete `buildODataFilter()` (already a no-op returning `undefined`) and its imports/
  call sites in `recipients/page.tsx` and anywhere else.
- Route count + send through the one typed filter so they can't drift.

### Pointers
- `convex/lib/contactQuery.ts`: delete the `filter?: string` field on `ContactFilter`
  and the leading ` and (${filter.filter})` clause in `buildContactFilterClauses`.
  Update the `buildContactFilter` "wraps a raw passthrough filter" test and the two
  characterization spreads (they set `filter: "riivo_taxmarketing eq true"`) — drop
  the `filter` key and its expected clause.
- `convex/lib/dynamics_util.ts`: drop `filter` from `CampaignFilters` + `toContactFilter`.
- `convex/actions/dynamics.ts`: drop the `filter: v.optional(v.string())` validator
  from all 7 filter-taking actions; remove the `filter` destructure + pass.
- `src/components/filters/ContactFilters.tsx`: delete `buildODataFilter` entirely (it
  now only ever returns `undefined`) and the `filters` arg lint warning with it.
- `src/app/recipients/page.tsx`: it still calls `buildODataFilter(filters)` and passes
  `filter: odataFilter` (always `undefined`) at ~3 sites — drop those.
  `src/app/campaigns/new/page.tsx` no longer passes `filter` after #34, but check for
  any stragglers.
- `src/components/filters/index.ts`: stop re-exporting `buildODataFilter`.

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
  or the send will silently drop it. **Channel reachability is the exception** — it is
  injected from the `channel` arg in `processCampaignFilters`, not carried in the
  stored filters.

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
