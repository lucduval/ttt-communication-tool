# PRD: Excel-driven campaigns with per-recipient CRM merge and invoice-PDF attachments

_Status: ready-for-agent · Owner: Luc · Created: 2026-07-20_
_Companion to `bad-debt-technical-requirements.html`_

## Problem Statement

An operator needs to run the bad-debt recovery campaign by uploading an Excel export from the CRM and having the tool send a personalised message to each person on that list — over both email and WhatsApp — where every message carries values specific to that person (their outstanding amount, invoice number, invoice date, a payment link) and a **PDF of their own invoice** so they know what is being referenced.

The tool today cannot do this. An uploaded file is treated purely as a _targeting_ mechanism: it extracts a single `contactid` GUID column, discards every other column, de-duplicates to unique contacts, and then re-resolves all message data from Dynamics at send time. Email merge supports only `{firstName}`, `{fullName}`, and `{email}`. Attachments are campaign-level (one shared set for everyone), not per-recipient. There is no way to (a) drive merge variables from the uploaded columns, (b) attach a different file per recipient, or (c) validate that every message will render fully before sending. As a result, the operator has no way to send correct, invoice-specific recovery messages from a spreadsheet.

## Solution

Let the **uploaded Excel be the source of truth** for message content. The operator uploads a CRM export (one row per person, restricted to people with a single outstanding invoice), the tool exposes the file's columns, and the operator inserts those columns as merge variables into a template. At send time the tool fills each message from that row's cells — no CRM round-trip for message data — and attaches that recipient's invoice PDF (fetched from an existing Azure function by invoice GUID). A **pre-send validation report** holds any row that cannot be rendered completely (missing column, empty referenced cell, invalid email, duplicate contact, or missing PDF) so nothing half-filled ever goes out.

Email and WhatsApp are run as **two separate single-channel campaigns**, each with its own upload and template, sharing the same merge/identity/attachment machinery. Email ships first; WhatsApp follows on the same foundation. The four campaign touches are **manual re-uploads** — one fresh export and send per touch — not tool-scheduled.

## User Stories

1. As an operator, I want to upload an Excel (`.xlsx`) or CSV export from the CRM, so that the people in it become the audience for a campaign.
2. As an operator, I want the tool to read back every column header in my uploaded file, so that I can see what data is available to merge.
3. As an operator, I want to choose which column is the send address (email) for an email campaign, so that the tool knows where to send.
4. As an operator, I want to choose which column is the tracking key (contact GUID), so that the tool can identify recipients and reconcile payments later.
5. As an operator, I want to insert any column into an email template as a `{column_name}` merge variable, so that each message renders that person's own values.
6. As an operator, I want the merge to be flat substitution (the tool does no formatting or branching), so that whatever I put in the cell is exactly what the recipient sees.
7. As an operator, I want to pre-render conditional content (e.g. a pay-now link vs EFT instructions) into a column in my export, so that the template stays a simple fill-in-the-blank with no branching logic in the tool.
8. As an operator, I want a saved template to keep working with future exports that share the same headers, so that I can reuse the bad-debt template across touches.
9. As an operator, I want the tool to refuse to send if a template `{placeholder}` has no matching column in my file, so that I never ship a literal `{amount}`.
10. As an operator, I want the tool to hold any row where a template-referenced cell is empty, so that I never send a message with a blank amount or invoice number.
11. As an operator, I want the tool to hold any row with an invalid or missing email address, so that sends don't fail mid-flight.
12. As an operator, I want the tool to detect when two rows share the same tracking key (a contact with more than one outstanding invoice) and hold/flag them, so that I only send to people with a single outstanding invoice for now.
13. As an operator, I want a single pre-send validation report listing every held row and why (missing column, empty cell, bad email, duplicate contact, missing PDF), so that I can fix my export and re-upload before anything sends.
14. As an operator, I want each recipient's own invoice PDF attached to their email, so that the client knows exactly which invoice is being referenced.
15. As an operator, I want the tool to generate each invoice PDF by calling the existing Azure function with the invoice GUID from my export, so that I don't have to produce the PDFs myself.
16. As an operator, I want the PDFs generated and stored ahead of the send (with a progress indicator), so that generation failures surface in the validation report rather than breaking a live send.
17. As an operator, I want the PDF generation for 300–500 recipients to finish in a couple of minutes, so that preparing a touch is not a long wait.
18. As an operator, I want to run a WhatsApp campaign as a separate upload, so that I can message people on WhatsApp independently of email.
19. As an operator, I want to upload an Excel with mobile numbers for WhatsApp and have the tool send to those numbers, so that I control exactly who is contacted.
20. As an operator, I want WhatsApp to only ever message the numbers I upload, so that consent/opt-in is controlled by what I choose to export.
21. As an operator, I want to select a pre-approved WhatsApp template rather than compose free text, so that sends comply with Meta's template rules.
22. As an operator, I want to map each of the WhatsApp template's positional variables to a column in my export, so that the body renders that person's amount, invoice number, and date.
23. As an operator, I want the WhatsApp template's "Pay Now" button to carry each client's unique payment link, so that they can pay in one tap.
24. As an operator, I want to supply the payment token (URL suffix) in a column and have it mapped to the button variable, so that Meta reconstructs the correct per-client URL.
25. As an operator, I want each recipient's invoice PDF sent as a WhatsApp document, so that WhatsApp recipients also get their invoice.
26. As an operator, I want WhatsApp body variables to come from my Excel columns (pre-formatted), so that there is one consistent source of truth across both channels.
27. As an operator, I want to click send once and trust that a crash or a double-click never double-messages anyone, so that recipients aren't spammed.
28. As an operator, I want to re-upload a fresh export for each of the four touches as a new campaign send, so that I control the cadence manually.
29. As an operator, I want to preview how a sample of messages will render (merged values + attached PDF) before sending, so that I can sanity-check the campaign.
30. As an operator, I want clear progress and per-recipient status (pending / sent / failed) during the send, so that I know where the campaign stands.
31. As an operator, I want to resend only to genuinely failed recipients, so that I can recover from partial failures without re-messaging everyone.
32. As a developer, I want merge, identity, validation, and chunking to be pure and unit-tested, so that correctness is verifiable without hitting Graph, Meta, or Dynamics.
33. As a compliance stakeholder, I want a person on the list to receive at most one message per campaign send, keyed on their contact identity, so that we stay within the collections code.

## Implementation Decisions

**Source-of-truth model (the load-bearing decision)**
- The uploaded Excel is the **source of truth** for all message content. The tool does **not** re-fetch merge data from Dynamics at send time. (This reverses the current Dynamics-resolved behaviour for these campaigns.)
- The only value re-fetched externally is the **invoice PDF** (via the Azure function), keyed by the invoice GUID column.

**Ingestion & columns**
- Parsing keeps the full row data (all columns), not just a single GUID column. The existing `.xlsx`/`.csv` reader is retained; the extractor is generalised from "find one contactid column" to "retain all columns + designate roles".
- The operator designates, per upload: a **send-address column** (email campaigns), a **tracking-key column** (contact GUID), and — for PDFs — an **invoice-GUID column**. Remaining columns are available as merge variables.

**Merge engine (flat)**
- A single pure merge function does **flat substitution only**: `{column_name}` → that row's cell value. No formatting, no conditionals, no drop-empty logic in the tool.
- All formatting (amounts as `R#,##0.00`, dates as `d MMMM yyyy`) and all conditional content (pay-now-link vs EFT block) are **pre-rendered into columns in the export** by whoever builds it.
- **Email** binds by name: placeholder text equals column header, using the existing `{curly}` syntax (not the spec's `[brackets]`).
- **WhatsApp** binds by position: Meta templates use opaque positional variables, so the operator maps each template variable → a column once per campaign, reusing the existing `variableMappings` concept but pointing it at Excel columns instead of CRM fields.

**Identity & idempotency**
- A recipient's identity is the **tracking-key column value** (contact GUID). The existing one-message-per-`(campaign, recipient)` idempotency seam (`markAttempted` / eligibility rule) is preserved unchanged, with the tracking key filling the `recipientId` slot.
- Two rows with the same tracking key = a contact with multiple invoices = **held/flagged at upload** (single-invoice-only rule enforced as a hard gate, not a guess).

**Pre-send validation gate**
- Before any send, the tool produces one validation report and **holds** (does not send) any row that: references a template placeholder with no matching column; has an empty cell in a referenced column; has an invalid/missing send address; shares a tracking key with another row; or has no successfully generated PDF.
- This report is the safety surface that replaces all conditional-rendering logic.

**Channels as separate campaigns**
- A campaign remains single-channel (`email | whatsapp | personalised`). "Email + WhatsApp" = two campaigns / two uploads sharing the same machinery. Email ships first; WhatsApp is an immediate fast-follow.
- WhatsApp opt-in is handled by _which numbers the operator exports_ — no per-row opt-in column.

**Per-recipient invoice PDFs**
- The Azure function takes an **invoice GUID** and returns **PDF bytes**. (Contract to be re-verified before build; single-call latency to be measured.)
- PDFs are **pre-generated and stored in Convex file storage** as a chunked background job with **bounded concurrency (~10–20 in flight)** and a progress indicator, reusing the existing batch/queue pattern. Generation failures surface in the validation gate.
- **Documents store only references** (`storageId`, and for WhatsApp a Meta `mediaId`) — never PDF bytes — to stay under Convex's 1 MiB per-document limit. Bytes are fetched from storage transiently at send time.
- **Email**: each recipient's PDF is fetched from storage at send and base64-inlined as a Graph `fileAttachment`. This deliberately reverses the current "resolve attachments once per batch" optimisation; per-recipient fetches are parallelised within a chunk.
- **WhatsApp**: for each recipient, upload the PDF to Meta → obtain a `mediaId` → send as the template's document header (the code's preferred media-id path over a link).

**Sizing guardrails**
- **Payload-aware `$batch` chunking**: cap Graph `$batch` at 20 sub-requests **and** at a ~3 MB cumulative-payload budget, so larger PDFs simply mean fewer messages per chunk. (Per-message stays well under Graph's ~4 MB limit.)
- Expect **IncomingBytes throttling** (rolling 5-min window per mailbox) because attachments multiply byte volume; the existing 429/backoff handling covers it, but attachment sends are inherently slower than plain sends — this is accepted.
- WhatsApp document size is well within Meta's 100 MB document limit.

**Schema changes (shape, not paths)**
- Persist the per-row column data for a recipient (the existing per-recipient `variables` bag is populated with the full row, and actually consumed by the email adapter — today it is populated only with a referral code and ignored by email).
- Per-recipient attachment references: `storageId` (Convex storage) and `whatsappMediaId` (Meta), plus a per-recipient **PDF generation status** (pending / generated / failed) to drive the validation gate.
- Per-campaign: the designated column roles (send address, tracking key, invoice GUID) and, for WhatsApp, the template-variable→column mapping.

## Testing Decisions

Good tests here assert **external behaviour at a seam**, not implementation details: given inputs (parsed rows, a template, a mocked HTTP response) they assert outputs (a validation report, a rendered message, a chunk plan, a Meta request body) — never internal call order or private state. Network boundaries (Graph, Meta, the Azure function, Dynamics) are mocked; nothing in the suite performs real sends.

Modules/seams to test (all favouring the highest existing seam):
- **Excel parse + validation report** — pure: rows → `{columns, rows}`; and `(template placeholders, rows, pdf-status)` → validation report (missing columns, empty referenced cells, invalid emails, duplicate tracking keys, missing PDFs). Prior art: the existing `extractContactIds` tests.
- **Merge engine** — pure `applyMerge(text, rowContext)`: correct substitution, and behaviour when a placeholder is unresolved (must never emit a literal `{placeholder}` — the validation gate catches it upstream). Prior art: current inline `applyMergeFields` behaviour.
- **Row identity / dedupe** — pure: tracking-key keying and duplicate detection. Prior art: `extractContactIds` de-dup tests.
- **Payload-aware `$batch` chunker** — pure: given messages with attachment sizes, produce chunks obeying both the count cap (≤20) and the byte budget. New seam, unit-tested in isolation.
- **PDF pre-gen orchestration** — mock the Azure-function HTTP client and Convex storage; assert storageId recorded per recipient, failures recorded, bounded concurrency respected. Prior art: `graph_client.test.ts` (mocked `fetch`).
- **WhatsApp variable resolution from row** — repoint `variableMappings` to the row bag; assert `buildTemplateRequestBody` produces the right body params + button suffix + document header, with a mocked Meta media upload. Prior art: `whatsapp.test.ts`.
- **Idempotency regression** — extend the existing send-idempotency regression to cover the file-as-source path (one message per `(campaign, tracking key)`, attempted-before-send seam intact with attachments). Prior art: `sendIdempotencyRegression.test.ts`.

General prior art: `convex/lib/__tests__/` (`sendEligibility`, `campaignTally`, `specialisedAudience`), `graph_client.test.ts`, `whatsapp.test.ts`.

## Out of Scope

- **Multi-invoice consolidation / invoice-level identity.** Only single-outstanding-invoice contacts are sent; multi-invoice rows are held. Moving to one-message-per-invoice (invoice-keyed idempotency) is a deliberate future change.
- **Automated four-touch cadence scheduling.** Touches are manual re-uploads.
- **Paystack link generation (BD-7).** Payment links/tokens come from the export; the tool does not mint them.
- **Recovery dashboard / payment reconciliation (BD-4).** The tracking key is retained to enable this later, but it is not built here.
- **Six-campaign template segmentation logic** (age bands × paid/never-paid). Segmentation is achieved by _which export the operator uploads_ and _which single template they choose_; the tool does not compute segments.
- **Conditional / branching template logic** in the tool. Pushed into export columns.
- **CRM re-fetch of merge data.** Merge values come only from the file.

## Further Notes

- **Dependency to verify before build:** the Azure function contract (input = invoice GUID, output = PDF bytes) and its **single-call latency** — this number determines whether pre-gen is ~1 min or several minutes for 300–500 recipients, and whether concurrency needs tuning.
- The invoice **GUID** used for PDF generation is a distinct column from the human invoice number (`INV-…`) referenced in the message body; the export must carry both.
- The WhatsApp button variable must be the **URL suffix/token** (e.g. `xY9abc`), not a full URL — Meta reconstructs `approved-prefix + suffix`.
- Amount and date must arrive **pre-formatted** in the export; the flat-merge tool does no formatting.
- Attachment sends are inherently slower than plain sends (per-recipient storage fetch + IncomingBytes throttling); operators should expect minutes, not seconds, for 300–500 recipients.
