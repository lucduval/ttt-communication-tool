# PRD — Stand up the Lead Query module

_Status: ready-for-agent · Source: architecture review (Candidate 3), 2026-06-17_

## Problem Statement

The Contact Query module was created to be the single deep place that turns campaign filters into Dynamics results, so the OData query dialect never appears outside it. Leads were left out of that work. The lead path in the Dynamics actions file hand-rolls its own filter builder, its own value escaping, its own pagination loop, and its own count — duplicating logic the Contact Query module already owns, and re-leaking the OData dialect the module was meant to contain.

This means a fix or improvement to the shared query mechanics (escaping, paging, retry, count behaviour) does not reach leads, and the lead query code drifts independently. It also keeps the already-oversized Dynamics actions file carrying query plumbing that belongs in a module.

## Solution

Stand up a **Lead Query** module that turns a typed lead filter into Dynamics lead results, expressing lead's own filter vocabulary while reusing the Contact Query module's OData dialect primitives and execution engine.

From a user's and developer's perspective:

- Filtering leads (by status, search, province, opt-in, owner, industry) behaves consistently with how contacts are filtered, and any improvement to the shared query mechanics applies to both.
- A developer adding or fixing a lead filter changes it in one module, with one place to test, and never hand-writes an OData string.
- The OData dialect (value escaping, `contains`, multi-select containment, pagination cursors) stays owned in one place, even though leads and contacts filter on different fields.

## User Stories

1. As an administrator targeting leads, I want to filter by status (active, inactive, or all), so that I reach the right leads.
2. As an administrator, I want to filter leads by free-text search across name and email, so that I can find specific leads.
3. As an administrator, I want to filter leads by province, email opt-in, WhatsApp opt-in, owner, and industry, so that my lead targeting is precise.
4. As an administrator, I want a search term containing apostrophes or special characters to be handled safely on the lead path, so that the query does not break.
5. As a non-admin consultant, I want my lead queries automatically restricted to my own effective owner, so that I cannot see leads outside my scope.
6. As an administrator using the recipient list, count, and "select all" for a lead audience, I want all three to agree, so that the audience I count is the audience I send.
7. As a developer, I want a single typed `LeadFilter` and one lead filter builder, so that lead filtering has one source of truth.
8. As a developer, I want the lead filter builder to be testable without calling Dynamics, so that I can assert the exact query produced for a given set of lead filters.
9. As a developer, I want lead counting and lead streaming to reuse the same pagination, retry, and count-fallback engine as contacts, so that I do not maintain a second pagination loop.
10. As a developer fixing a query-mechanics bug (escaping, paging, retry), I want the fix to apply to both contacts and leads, so that they cannot diverge.
11. As a maintainer, I want the OData dialect to never appear in the Dynamics actions file for leads, so that the dialect stays contained in the query modules.
12. As a maintainer, I want owner scoping applied as the leads are queried, so that a future caller cannot forget it.
13. As a maintainer, I want the lead actions reduced to thin callers of the Lead Query module, so that the Dynamics actions file stops carrying query plumbing.

## Implementation Decisions

**Shared dialect and engine, separate clause-builders.** Contacts and leads have genuinely different filter vocabularies (leads filter on status and opt-ins; contacts on client type, source code, bank, entity type, age, geographic location, name range) and use different field names for the four overlapping concepts (search, province, industry, owner). A single clause-builder over both would be as wide as both implementations combined — a shallow switch in disguise. Instead each entity keeps its own typed filter and its own clause-builder, and both compose the same OData dialect primitives and the same execution engine.

**Generalise the Contact Query execution into an entity-agnostic core.** The contact-bound execution operations (stream, count, fetch-page) are generalised to accept a prebuilt filter expression plus the entity, select, order, and id-field, with the contact operations becoming thin facades over them. The streaming/paging/retry helpers and the value-escaping helper are already entity-agnostic; their exports are widened so the Lead Query module can consume them. The count operation keeps its behaviour of using the reported count below a ceiling and paginating ids above it.

**New module: Lead Query.** A sibling to Contact Query owns a typed `LeadFilter`, a lead filter builder (status to state-code mapping including the always-true placeholder for "all"; search, province, opt-ins, owner, industry in lead's field names), and lead-specific stream, count, and fetch-page operations built on the shared core. The owner scope is applied inside the module because the filter is built there from the typed object, so it cannot be silently skipped.

**Owner scoping stays at the action seam, feeds the module.** Resolving a non-admin's effective owner requires request context and the current user, so it remains in the action layer; the resolved owner is passed into the Lead Query module, which applies it to the query.

**Call sites migrated.** The lead recipient list, lead count, and lead "select all" actions are reduced to thin callers of the Lead Query module. The hand-rolled lead filter builder, the bespoke pagination loop, and the bespoke count in the Dynamics actions file are deleted.

**Phasing.** (1) generalise the Contact Query execution into the entity-agnostic core and widen the dialect exports, with contact behaviour unchanged; (2) stand up the Lead Query module with characterization tests pinning the current lead filter output; (3) migrate the three lead actions to the module and delete the duplicated plumbing. Each phase ships independently with the build and tests green.

## Testing Decisions

**What makes a good test here.** Tests assert the externally observable contract: given a typed `LeadFilter`, the filter expression is correct; given a faked request boundary, counting and streaming page and tally correctly. Tests target the module's interface, not its internals.

**Modules tested.**

- The lead filter builder is the primary pure test surface. Characterization tests first lock the current lead filter output for representative combinations (status active/inactive/all, search with apostrophes, province, opt-ins, owner, industry); these document the behaviour the migration must preserve.
- Lead counting and streaming are tested against a faked request boundary so pagination, cursor handling, retry, and the count-fallback are exercised without a live CRM.
- Owner scoping is asserted: a non-admin's effective owner always appears in the produced lead filter.
- The shared value-escaping helper, now used by both contacts and leads, is asserted once.

**Prior art.** The Contact Query tests under the Convex lib test directory are the direct model: pure filter-builder assertions plus a faked request boundary. The Lead Query tests mirror them.

## Out of Scope

- Changing which lead filters exist or adding new lead filters.
- Decomposing the rest of the Dynamics actions file beyond the lead query plumbing.
- Lifting the shared dialect/engine into its own base module separate from Contact Query (it remains exported from Contact Query for now; this can be revisited later).
- Schema changes in Dynamics.

## Further Notes

- This is a consolidation, not a correctness fix: the lead escaping currently in place is identical to the shared escaping helper, so unifying it buys locality (one dialect owner), not a behaviour change. (Contrast the Client Type fix in the Contact Query work, which was a genuine correctness change.)
- The deletion test confirms the module earns its keep: deleting it would scatter escaping, paging, retry, and filter-building back into the lead actions and re-leak the OData dialect.
- The execution engine being already entity-agnostic means Phase 1 is largely widening exports and adding entity parameters, not rewriting paging.
