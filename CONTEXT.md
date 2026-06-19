# TTT Communication Tool

Domain language for the campaign/communication tool that targets contacts in Microsoft Dynamics CRM and sends them email, WhatsApp, and personalised-tax campaigns.

## Language

### Audiences & querying

**Contact Query**:
The single deep module (`convex/lib/contactQuery.ts`) that turns a typed campaign-filter object into Dynamics contact results — owning filter construction, value escaping, multi-select encoding, owner scoping, pagination, and retry. The Dynamics OData dialect never appears outside it. Its filter vocabulary includes an `contactIds` dimension: when set, Contact Query restricts to that id set and owns the `contactid eq` encoding plus the OR-ceiling chunking (results stream per-chunk, not globally ordered), so a Specialised audience never hand-builds id clauses.
_Avoid_: filter builder, OData helper, query service.

**Campaign filters**:
The typed set of contact-level criteria (search, client type, entity type, bank, source code, province, age range, owner, industry, name range) a user picks when building a campaign. Resolved into a Contact Query, never hand-built as a string.
_Avoid_: query params, search criteria.

**Lead Query**:
The sibling module (`convex/lib/leadQuery.ts`) that turns a typed `LeadFilter` into Dynamics lead (`new_leads`) results. It expresses lead's own filter vocabulary (status active/inactive/all, email/whatsapp opt-in) but reuses Contact Query's OData dialect primitives and execution engine, so the dialect stays owned in one place.
_Avoid_: lead filter builder, lead service.

**Specialised audience**:
A campaign target resolved by first scanning a related entity (ITA34, tax-return invoices, open bad-debt invoices, referral participants) for contact ids, then re-querying those contacts. The deep module (`convex/lib/specialisedAudience.ts`) splits into a **Scan adapter** per audience and one **resolver** shared by all of them. The Scan adapter owns the only part that varies — the related-entity query, the collapse to one row per contact (the ITA34 adapter reuses Tax Profile's `pickLatest` rather than reimplementing latest-year selection), and the in-memory membership test ("who has income in range") — returning qualifying contact ids plus the per-contact figure to display. The resolver re-queries those ids through Contact Query's `contactIds` dimension (so the OData dialect and id-chunking stay owned there) and joins each contact with its scan figure and, for income audiences, its Tax Profile display figure. One resolver feeds both the recipient-list/preview path and the send path, so the two cannot diverge.
_Avoid_: custom audience, segment, scan helper.

**Tax Profile**:
The deep module (`convex/lib/taxProfile.ts`) that owns *a single client's canonical tax figures* — given a contact id, the ITA34/IRP5 figures (income, taxable income, RA contributions, year of assessment, …) for that client's **latest year of assessment**. One module owns the entity read, the latest-year selection rule, and the field mapping into `TaxProfileData`, so the figure shown in the recipient list, the figure in the personalised preview, and the figure in the sent email are the same value. Answers a per-contact *value* question; membership ("who has income in range") stays with the income-filtered Specialised audience query, which reads figures through this module rather than mapping its own. "Income" displayed to advisors means **taxable income** (`riivo_taxableincomeassessedloss`) — the figure the RA pitch is computed against — everywhere.
_Avoid_: tax data helper, ITA34 service, income lookup.

**Recipient Selection**:
The deep module that owns *who a campaign sends to* as a single value, in one of two mutually-exclusive shapes: **explicit** (hand-picked contacts held in memory) or **filtered** (a Contact Query filter plus an excluded-id set — "select all minus unchecks"). It exposes three projections that always agree because they derive from the same value: `count` (recipient total), `sample(n)` (up to n concrete contacts for preview display, fetched from the query in filtered mode), and `toCampaignArgs` (the `recipients[]`-or-`filters` payload sending consumes). The pure model is the test surface; a thin hook wires the count/sample fetches.
_Avoid_: selected contacts, recipient list, selection state.

### Sending

**Channel**:
The medium a campaign sends through: `email`, `whatsapp`, or `personalised`. Stored on the campaign and used to select a Channel Sender.
_Avoid_: medium, type, mode.

**Channel Send**:
The deep module that drives sending a queued campaign batch. A single driver owns the batch lifecycle (claim, flush, complete, reschedule, fail), holds the Batch Lease for the claimed batch (beating `heartbeatAt` from its `emit` path), and selects a Channel Sender by channel.
_Avoid_: send service, dispatcher.

**Channel Sender**:
The adapter behind the Channel Send seam for one channel. It owns only that channel's per-recipient send loop and side-effects, streaming results back to the driver via `emit` and reporting an optional `halt` and successor `nextDelayMs`.
_Avoid_: sender service, handler, provider.

**Batch**:
A fixed-size slice of a campaign's recipients processed by one worker run (email 100, whatsapp 1000, personalised 50). The unit of the Channel Send lifecycle.
_Avoid_: chunk, page (page belongs to Contact Query pagination).

**Batch Lease**:
The deep module that owns campaign *liveness* — the invariant "exactly one live worker per active campaign, and the chain never silently dies." A worker holds a lease on the batch it claims by bumping the batch's `heartbeatAt` as it streams results (the Channel Send driver writes the beat from its `emit` path, throttled to at most once per 30s, so the cadence is bounded across channels). A batch is *dead* when it is still `processing` but its heartbeat is older than the lease (~3 min); a heartbeat-aware sweep (the recover-stuck-batches cron, ~1 min) resets dead batches to `pending` and re-kicks one worker. Death detection keys off last-progress (`heartbeatAt`), not claim time (`startedAt`), so a slow-but-alive worker is never falsely revived — which is what keeps a revived worker from sending in parallel and breaching the Graph IncomingBytes (150 MB / 5 min per mailbox) or WhatsApp rate limits. The lease predicate and revive step are the test surface; an injected clock replaces "wait for a production stall."
_Avoid_: stuck-batch recovery, watchdog, timeout guard.
