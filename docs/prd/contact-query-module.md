# PRD — Deepen the Contact Query module

_Status: ready-for-agent · Source: architecture review (Candidate 1), 2026-06-11_

## Problem Statement

When an administrator builds a campaign, the recipient **count** they see while choosing filters can disagree with **who actually receives** the campaign. The two are computed by separate code paths that build their Dynamics query differently, so the same set of filters can resolve to different audiences.

Concretely, filtering by **Client Type** is currently broken on both paths. `riivo_clienttypenew` is a multi-select field in the CRM, but both paths query it with an equality match (`eq`) instead of multi-select containment. One path compares it as a quoted string, the other coerces it to a single number. Neither reliably matches contacts, so a Client Type filter can silently return the wrong people — or everyone.

More broadly, the rules for translating campaign filters into a Dynamics query are copy-pasted across roughly nine places. Any fix or new filter has to be made in every copy, and the copies have already drifted apart. This makes the filtering behaviour hard to trust, hard to test, and hard to change.

## Solution

Introduce a single **Contact Query module** that owns everything about turning campaign filters into Dynamics contact results: filter construction, value escaping, multi-select encoding, owner scoping, pagination, and retry. Every part of the product that needs matching contacts — the recipient list, the recipient count, "select all", and the campaign send — asks this one module.

From a user's perspective:

- The recipient count always matches the audience that actually gets the campaign, because both come from the same module.
- Filtering by Client Type (and any other multi-select field) returns the correct contacts.
- Adding or correcting a filter changes behaviour everywhere consistently, with no drift between "preview" and "send".

## User Stories

1. As an administrator building a campaign, I want the recipient count shown during filtering to match the number of contacts who actually receive the campaign, so that I can trust the audience size before I send.
2. As an administrator, I want to filter recipients by Client Type and get exactly the contacts who hold any of the selected client types, so that my targeting is correct.
3. As an administrator, I want to select multiple Client Type values at once and have all matching contacts included, so that multi-select targeting works the way the CRM models the field.
4. As an administrator, I want every filter (search, entity type, bank, source code, province, geographic location, age range, industry, owner, name range) to behave identically whether I am previewing, counting, selecting all, or sending, so that there are no surprises between steps.
5. As an administrator using "select all", I want the full matching set to be the same set that is counted and sent, so that exclusions and totals stay consistent.
6. As an administrator scheduling a tax-return, ITA34, bad-debt, or referral-participant campaign, I want the contact-level filters applied identically to a normal campaign, so that these specialised audiences honour the same targeting rules.
7. As a non-admin consultant, I want my contact queries automatically restricted to my own contacts on every path, so that I cannot accidentally see or message contacts outside my scope.
8. As an administrator, I want a search term containing apostrophes or other special characters to be handled safely, so that the query does not break or behave unexpectedly.
9. As a developer adding a new recipient filter, I want to add it in one place and have it apply to listing, counting, select-all, and sending, so that I cannot introduce drift.
10. As a developer fixing a filtering bug, I want one place to change and one place to test, so that the fix is guaranteed to apply everywhere.
11. As a developer, I want the filter-building logic to be testable without calling Dynamics, so that I can assert the exact query produced for a given set of filters.
12. As a developer, I want pagination, cursor handling, and retry to live inside the module, so that callers never reconstruct Dynamics pagination details.
13. As a maintainer, I want the OData query dialect to never appear outside the Contact Query module, so that the rest of the codebase is insulated from Dynamics query syntax.
14. As a maintainer, I want owner scoping enforced as the contacts are queried, so that a future caller cannot forget to apply it.

## Implementation Decisions

**New module: Contact Query.** A single module becomes the only place that knows how to turn campaign filters into Dynamics contact results. It is the deep module behind which the Dynamics OData dialect is hidden. Its name enters the project glossary (CONTEXT.md) as the canonical term.

**Interface (what callers must know).** Callers provide a typed set of campaign filters and receive contacts, a count, or a streamed sequence of contact chunks. Callers never see or construct OData strings, pagination cursors, or page-size headers. The module exposes three responsibilities:

- Build the contact filter from a typed filter object (pure, no I/O).
- Count matching contacts.
- Stream matching contacts in chunks for large audiences.

**Canonical filter type.** The two divergent filter type definitions are merged into one. Multi-select fields are typed as arrays of option-set codes. In particular, Client Type changes from a scalar (`string | number`) to an array of numeric option codes, matching how Source Code is already modelled.

**Multi-select encoding (correctness fix).** Multi-select option-set fields are filtered with containment, not equality. Client Type adopts the same encoding already used for Source Code:

```
Microsoft.Dynamics.CRM.ContainValues(PropertyName='riivo_clienttypenew',PropertyValues=['<code>','<code>'])
```

This replaces both current behaviours (`... eq '<string>'` and `... eq <number>`), which are incorrect for a multi-select field.

**Single escaping rule.** String value escaping (e.g. apostrophes in search and province) is defined once inside the module and applied uniformly.

**Owner scoping stays at the action seam, feeds the module.** Resolving a non-admin's effective owner requires request context and the current user, so that resolution remains in the action layer. The resolved owner is passed into the Contact Query module, and the module is responsible for applying it to the query, so the scoping cannot be silently dropped by a new caller.

**Pagination and retry move inside.** Cursor extraction, base-URL normalisation, page-size control, and retry-with-backoff become internal to the streaming/counting calls. The `dynamicsRequest` primitive is consumed directly from the auth module rather than via a re-export from the actions layer, removing the existing indirection.

**Call sites migrated.** The recipient list, recipient count, "select all", the chunked send-time fetch, and the shared extra-filter helper all delegate to the Contact Query module. The specialised audience queries (tax return, ITA34, bad debt, referral participants) keep their own related-entity lookups but delegate their contact-level filtering to the same module.

**Phasing.** The work proceeds as: (0) characterization tests pinning current filter output; (1) extract the pure filter builder and route all call sites through it with no behaviour change where paths already agree; (2) correct the Client Type multi-select encoding and unify the divergence; (3) move pagination/retry/owner application inside the module; (4) migrate the specialised audience queries. Each phase ships independently with the build and tests green.

## Testing Decisions

**What makes a good test here.** Tests assert the externally observable contract of the module: given a typed set of filters, the filter expression and the resulting matched contacts are correct. Tests target the module's interface, not its internals — they do not reach past it into private helpers.

**Modules tested.**

- The pure filter builder is the primary test surface. Characterization tests first lock current output for representative filter combinations (Phase 0). The Client Type cases are then updated to assert multi-select containment encoding (Phase 2), documenting the corrected behaviour.
- The streaming and counting behaviour is tested against a faked `dynamicsRequest` so that pagination, cursor handling, and retry are exercised without a live CRM.
- Owner scoping is asserted: a non-admin's effective owner always appears in the produced filter.

**Prior art.** The repository already tests pure library logic without external calls (for example the WhatsApp library tests and tracking-utility tests under the Convex lib test directory). The Contact Query tests follow the same shape: pure-function assertions plus a faked request boundary.

**Manual confirmation.** Before rollout, run one live Client Type query against Dynamics to confirm the containment encoding returns the expected contacts, since this is a behaviour change on a previously broken filter.

## Out of Scope

- Candidates 2–6 from the architecture review (template-variable resolution, channel send adapter, campaign status transitions, the new-campaign god page, CRM logging failure modes). The frontend god-page cleanup (Candidate 5) is a natural follow-on once the UI can call the Contact Query module, but it is tracked separately.
- Changing which filters exist or adding new audience types.
- Schema changes in Dynamics. This work corrects how an existing multi-select field is queried; it does not modify the CRM model.
- Performance tuning of pagination beyond preserving current page-size and retry behaviour.

## Further Notes

- The Client Type fix is a genuine correctness change on a currently broken filter, not a pure refactor. The count a user sees today may change once the fix lands; this is expected and is the point.
- The divergence was introduced because filter-building was copy-pasted; consolidating behind one module is what prevents recurrence. The deletion test confirms the module earns its keep: removing it would scatter the same logic back across roughly nine callers, where it would drift again.
- Source Code is already a correctly-handled multi-select and serves as the reference implementation for the Client Type fix.
