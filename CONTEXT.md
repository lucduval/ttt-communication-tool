# TTT Communication Tool

Domain language for the campaign/communication tool that targets contacts in Microsoft Dynamics CRM and sends them email, WhatsApp, and personalised-tax campaigns.

## Language

### Audiences & querying

**Contact Query**:
The single deep module (`convex/lib/contactQuery.ts`) that turns a typed campaign-filter object into Dynamics contact results — owning filter construction, value escaping, multi-select encoding, owner scoping, pagination, and retry. The Dynamics OData dialect never appears outside it.
_Avoid_: filter builder, OData helper, query service.

**Campaign filters**:
The typed set of contact-level criteria (search, client type, entity type, bank, source code, province, age range, owner, industry, name range) a user picks when building a campaign. Resolved into a Contact Query, never hand-built as a string.
_Avoid_: query params, search criteria.

**Lead Query**:
The sibling module (`convex/lib/leadQuery.ts`) that turns a typed `LeadFilter` into Dynamics lead (`new_leads`) results. It expresses lead's own filter vocabulary (status active/inactive/all, email/whatsapp opt-in) but reuses Contact Query's OData dialect primitives and execution engine, so the dialect stays owned in one place.
_Avoid_: lead filter builder, lead service.

**Specialised audience**:
A campaign target resolved by first scanning a related entity (ITA34, tax-return invoices, open bad-debt invoices, referral participants) for contact ids, then re-querying those contacts. The related-entity scan is the only part that differs per audience; the contact-level filtering delegates to Contact Query.
_Avoid_: custom audience, segment.

### Sending

**Channel**:
The medium a campaign sends through: `email`, `whatsapp`, or `personalised`. Stored on the campaign and used to select a Channel Sender.
_Avoid_: medium, type, mode.

**Channel Send**:
The deep module that drives sending a queued campaign batch. A single driver owns the batch lifecycle (claim, flush, complete, reschedule, fail) and selects a Channel Sender by channel.
_Avoid_: send service, dispatcher.

**Channel Sender**:
The adapter behind the Channel Send seam for one channel. It owns only that channel's per-recipient send loop and side-effects, streaming results back to the driver via `emit` and reporting an optional `halt` and successor `nextDelayMs`.
_Avoid_: sender service, handler, provider.

**Batch**:
A fixed-size slice of a campaign's recipients processed by one worker run (email 100, whatsapp 1000, personalised 50). The unit of the Channel Send lifecycle.
_Avoid_: chunk, page (page belongs to Contact Query pagination).
