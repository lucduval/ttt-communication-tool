/**
 * `Invoice - Scheduled - Send Bad Debt Recovery Touches` — issues #98–#103.
 *
 * The selection half of the bad-debt cadence, the campaign key that says WHICH
 * message each selected client is due, the two inputs that message needs, the
 * one brake that looks at the run as a whole, and both channels that speak:
 * email from #102, WhatsApp from #103.
 *
 * #103 turns on WhatsApp, which is the channel the 24 approved templates were
 * written for and the one the campaign key has been resolving a name for since
 * #99. The send is lifted from the proven cadence flow c430ace5: upload the
 * invoice PDF to Meta's media endpoint, take the media id as the template's
 * document header, build body and button components, POST the template, and
 * log the result to `riivo_whatsappcommunicationses`.
 *
 * Four things were read off the deployed org rather than assumed, and three of
 * them changed the build:
 *
 *  - THE BUTTON TAKES THE BARE TOKEN. Meta stores the approved URL prefix and
 *    rebuilds prefix + suffix, so a full URL yields a link to a link. #100
 *    published both forms from one compose for exactly this; the email reads
 *    `url`, this reads `token`, and nothing here builds a URL at all.
 *  - THE TWO TEMPLATE FAMILIES TAKE DIFFERENT BODY PARAMETERS. The 24 campaign
 *    templates are name + amount; the D12 fallback
 *    `ttt_invoice_reminder_paylink_v2` is name + invoice number + amount. #99
 *    could not have known, and sending two parameters to a three-parameter
 *    template is a 400 — so every client who ever reached touch 5 would have
 *    gone silent, months after the code that caused it shipped.
 *  - THE MULTIPART BODY MUST NOT BE INTERPOLATED. `@base64ToBinary(x)` uploads
 *    the PDF; `@{base64ToBinary(x)}` uploads its base64 TEXT, and Meta accepts
 *    both. `[TEST] WhatsApp Invoice - Buggy vs Fixed PDF Upload` is still
 *    deployed in dev as the record of someone finding that the hard way.
 *  - PARAMETERS ARE SANITISED AND THEN CHECKED. Meta refuses a parameter
 *    carrying a newline, a tab or four consecutive spaces, with a 400 rather
 *    than a visibly broken message.
 *
 * AND ONE THING THAT IS NOT A CODE PROBLEM AT ALL: there is ONE TTT WhatsApp
 * number, no sandbox of it, and no `riivo_SendEmail` equivalent to hold a
 * message back. Dev and prod post to the same Meta phone number id, so a run
 * in dev sends a real message from the live business number to a real handset.
 * Test mode and the canary list are the whole of the safety envelope — which
 * is why #103's rehearsal is canary-only and why the canary list matters more
 * here than it did for email.
 *
 * #102 turns on the email channel and adds the mechanism that makes turning it
 * on survivable. Two halves:
 *
 * THE SEND is one call to the house child `Email - Child - Build Branded HTML
 * Email, Create or Send` (0d0bc4d6), copied from the proven cadence flow
 * c430ace5, which already calls it with an invoice PDF and a Pay-now button.
 * Inspecting that child on 2026-09-11 settled the open question the issue
 * flags as its main risk: it takes `buttonUrl`/`buttonLabel` AND
 * `attachmentsJson` in the same call, and it creates the `activitymimeattachment`
 * rows BEFORE it performs `SendEmail`, so the attachment is on the message the
 * client receives rather than added to a sent mail afterwards. It is the house
 * pattern in full — a Dataverse `email` row, the attachment, then the bound
 * `SendEmail` — which is what keeps the message on the client's timeline and
 * inside TTT's email statistics; the Office 365 Outlook connector bypasses both
 * and is used nowhere in this path.
 *
 * THE CANARY is `riivo_BadDebtCanaryContactIds`. Until #102 there was no way to
 * send to three people rather than the whole book, and "rehearse on colleagues,
 * then canary on a few real clients" is most of what this issue asks for. The
 * list restricts the SELECTION QUERY, not a later condition, so a client who is
 * not on it is never fetched, never minted for, never rendered for. A canary run
 * skips the tripwire (a run restricted by hand is anomalous by construction) and
 * is recorded as outcome `canary`, which is NOT a baseline — otherwise the next
 * unrestricted run would look like a twentyfold explosion and park. And every
 * canary run alerts the team, because the failure mode of an allowlist is not
 * that it is set, it is that it is left set: a campaign that quietly speaks to
 * three people forever is worse than one that nags.
 *
 * #101 adds the volume tripwire. Every other guard here is per-recipient — no
 * message without its PDF, per-channel consent, the last-sent recency test —
 * and none of them can see a filter regression that matches ten times the usual
 * population, an upstream change that empties the selection, or a bad-debt
 * creation flow that floods the table overnight. So after selection, and
 * before the loop that mints tokens and renders PDFs, the run compares its
 * selected count against the last run that was acted on and parks itself if the
 * two disagree by more than a configured proportion. A parked run alerts the
 * team through the house failed-flow child and terminates: nothing minted,
 * nothing generated, nothing written against any client, nothing to clean up
 * before re-running it. The count of every run — parked, live or rehearsal — is
 * recorded on `riivo_baddebtrun` (see `badDebtRunTable.ts`), which is both
 * where the next run's baseline comes from and a run history the campaign can
 * be measured against.
 *
 * #100 adds the payment token and the invoice PDF, under one guarantee carried
 * over from the comms tool's pre-send validation gate — which is otherwise out
 * of the path now that sending is unattended: NO MESSAGE GOES OUT WITHOUT ITS
 * ATTACHMENT. Both inputs are produced inside `Scope_|_Prepare_Documents`; if
 * either cannot be produced, that client's touch ends, their bookkeeping is
 * left untouched so the next run retries them, and they appear in the report
 * as a held row naming the reason. One client's failure is contained by the
 * scope and cannot end the run for anyone else.
 *
 * #99 added two halves of one mechanism. `riivo_campaignsendcount` chooses the
 * template, and the touch increments it, so template resolution and touch
 * bookkeeping cannot be built apart. Both are built here; the bookkeeping
 * WRITE is gated on a send having succeeded. `Compose_|_Send_Outcome` was the
 * seam; #102 filled in its email half and #103 the other. It is still an OR,
 * which is the campaign's rule rather than an accident of the seam: a client
 * reached on either channel has had their touch, because counting it twice
 * would spend two rungs of a five-rung ladder in a single day.
 *
 * WHY THIS IS AUTHORED AS CODE RATHER THAN CLICKED TOGETHER
 * The flow is unattended by decision (D5), so none of the comms tool's human
 * checks — validation report, sample preview, hold list — sit in front of it.
 * Authoring the definition here means the properties that matter are pinned by
 * `__tests__/badDebtRecoveryTouches.test.ts` and re-checked on every edit,
 * instead of living only as clicks in a maker-portal designer nobody diffs.
 *
 * LINEAGE — two parents, not one
 * #98 says to clone `Invoice - Scheduled - Payment Reminder & Link Cadence`
 * (c430ace5). That flow is the right source for the SEND half and for consent
 * polarity, both of which are copied from it verbatim below. But a dev-org
 * inspection on 2026-09-11 turned up a closer sibling for the SELECTION half:
 * `Invoice - Scheduled - Bad Debt Referral & Owner Digest` (dd5a766f, off),
 * which already queries the referred-to-bad-debt population. Its shape — the
 * test-mode compose, the capped loop, the dedupe-before-act pattern — is what
 * this follows.
 *
 * That flow also runs daily at 09:30 SAST and CREATES `riivo_baddebt` rows,
 * which is why the recurrence here is 09:45 and not the 09:30 the issue asked
 * for: reading the table on the same tick that another flow writes it is a
 * race, and fifteen minutes costs nothing.
 *
 * Population is `riivo_baddebt` rows directly, not invoices carrying
 * `riivo_referredtobaddebts eq true`. Both reach the same debtors, but the
 * digest flow's invoice-side query is fenced by a go-live `createdon` floor
 * that exists to keep legacy referrals out of ITS campaign book. Inheriting
 * that floor here would silently exclude the legacy bad debt that is most of
 * the book — the opposite of what this campaign is for.
 */

import {
  BASELINE_OUTCOMES,
  RUN_OUTCOME,
  RUN_TABLE_ID,
  RUN_TABLE_SET,
} from "./badDebtRunTable";

export const FLOW_NAME = "Invoice - Scheduled - Send Bad Debt Recovery Touches";

/** Dataverse environment variable holding the minimum gap between touches. */
export const TOUCH_GAP_VARIABLE = "riivo_BadDebtMinDaysBetweenTouches";

const TEST_MODE_PARAM = "Reminder Test Mode (riivo_ReminderTestMode)";
const TOUCH_GAP_PARAM = `Bad Debt Min Days Between Touches (${TOUCH_GAP_VARIABLE})`;

/**
 * The tripwire's one tuning knob, and its default.
 *
 * String rather than Number, following `riivo_BadDebtMinDaysBetweenTouches`
 * and `riivo_CcSizeCap`: every numeric environment variable in this org is
 * typed String and read through `int()`. The default is a fallback for a
 * missing variable, not the source of truth — and `int()` on a non-numeric
 * value throws, which fails the run before the loop rather than sending with a
 * threshold nobody meant.
 */
export const VOLUME_THRESHOLD_VARIABLE =
  "riivo_BadDebtVolumeChangeThresholdPercent";
export const DEFAULT_VOLUME_THRESHOLD_PERCENT = 40;
const VOLUME_THRESHOLD_PARAM = `Bad Debt Volume Change Threshold Percent (${VOLUME_THRESHOLD_VARIABLE})`;

/**
 * `Utility - Child - Email Team a Failed-Flow Alert with Run Link`, on in dev,
 * called by 218 of the org's 322 modern flows in exactly this shape: alert,
 * then `Terminate` with `runStatus: Failed`.
 *
 * It is used here instead of creating an `email` row and performing a bound
 * `SendEmail` for three reasons. It owns the notification target already, as
 * `riivo_varFlowErrorTeamMail` — so the target is an environment variable and
 * a parked run lands in the channel operators already watch for flow failures,
 * rather than a second bad-debt-specific inbox nobody has a habit of reading.
 * It owns the sender (the shared-mailbox queue) and the run link. And most of
 * all, reproducing the send here would cost this build its strongest guarantee:
 * that this flow creates no `email` row and performs no `SendEmail` at all
 * until #102/#103 deliberately add one. That assertion is worth more than a
 * dedicated recipient.
 *
 * PROMOTION HAZARD: a child flow is addressed by workflowid, so this is the
 * second line in this file — with `PDF_CHILD_FLOW_ID` — that cannot travel to
 * prod unchanged.
 */
export const ALERT_CHILD_FLOW_ID = "6b0bff17-e79b-ed11-aad1-000d3ab479cf";
const ENVIRONMENT_ADDRESS_VARIABLE = "riivo_EnvironmentAddress";
const ENVIRONMENT_ADDRESS_PARAM = `Environment Address (${ENVIRONMENT_ADDRESS_VARIABLE})`;

/**
 * `Email - Child - Build Branded HTML Email, Create or Send`, on in dev, read
 * 2026-09-11. 39 flows in this org call it; 16 of them are on.
 *
 * It owns the entire house send pattern: it builds the branded HTML from
 * subject + paragraph JSON, creates the Dataverse `email` row, writes each
 * `activitymimeattachment`, and only THEN performs the bound `SendEmail`. It
 * also re-reads the recipient at send time and refuses on `donotemail` or a
 * recorded bounced address, answering `sent`/`skipped`/`skipReason` rather
 * than failing — a second consent check behind our own, evaluated later and
 * therefore against fresher data.
 *
 * Reimplementing any of that here would mean owning the branded template, the
 * unsubscribe footer, the signature resolution and the attachment ordering,
 * four things that already have one home.
 *
 * PROMOTION HAZARD: the third workflowid in this file that cannot travel to
 * prod unchanged, with `PDF_CHILD_FLOW_ID` and `ALERT_CHILD_FLOW_ID`.
 */
export const EMAIL_CHILD_FLOW_ID = "0d0bc4d6-7f74-f111-ab0e-000d3ada6ac0";

/**
 * The sender the child is told about, and the switch it obeys.
 *
 * `variant: System` means the From party is the service queue
 * (`riivo_ServiceQueue`, TTT Notifications) rather than a consultant, and it
 * also disables the child's CC-the-owner behaviour entirely — which is what we
 * want for an unattended collections run: no consultant is CC'd on a few
 * hundred dunning emails twice a week. `senderUserId` is still REQUIRED by the
 * child (it validates it non-empty and then reads that systemuser), so a value
 * has to be supplied even though System variant does not send as them. The
 * existing `riivo_SharedSenderUserId` — "Shared Sender User Id (fallback From)"
 * — is exactly that value, already in the org, so this build adds no variable
 * for it and no owner-resolution subtree of its own. c430ace5 passes the
 * invoice's owner instead, which drags in a whole team-owner branch to answer
 * a question System variant does not ask.
 *
 * `riivo_SendEmail` is an ORG-WIDE switch the child reads: with it off every
 * caller's mail is created and saved as a draft instead of being sent. It is
 * off in dev. Read here purely so the run can SAY so — a rehearsal that
 * produces drafts otherwise looks identical to a rehearsal that silently
 * failed. Nothing in this flow branches on it; the child's own `sent` answer
 * is what gates the bookkeeping.
 */
const SENDER_USER_VARIABLE = "riivo_SharedSenderUserId";
const SENDER_USER_PARAM = `Shared Sender User Id (fallback From) (${SENDER_USER_VARIABLE})`;
const SEND_EMAIL_VARIABLE = "riivo_SendEmail";
const SEND_EMAIL_PARAM = `Send Email (${SEND_EMAIL_VARIABLE})`;

/**
 * The Meta WhatsApp Cloud API contract, all three values read from
 * `environmentvariabledefinitions` under the exact display names the proven
 * cadence flow c430ace5 and the house child 5c025055 already bind to.
 *
 * `riivo_varMetaAccessToken` is a live bearer token held as a plaintext
 * default on its environment variable — the same hazard as
 * `riivo_PaymentLink_FunctionKey`, and the same treatment: EMPTY defaults
 * here, so no secret reaches this file or any solution export of the flow.
 *
 * ONE NUMBER, NOT TWO. Dev's `riivo_varMetaURI` and prod's name the same Meta
 * phone number id (1126852847178432), because there is one TTT WhatsApp
 * Business number and Meta has no sandbox of it. So a WhatsApp send from the
 * dev org is a REAL message from the live business number to a real handset.
 * There is no `riivo_SendEmail` equivalent for WhatsApp — no draft mode, no
 * redirect, nothing between a run and the client's phone but test mode and the
 * canary list. That asymmetry is the single most important thing to know
 * before switching this on, and it is why #103's rehearsal is canary-only.
 */
const META_SEND_URI_VARIABLE = "riivo_varMetaURI";
const META_UPLOAD_URI_VARIABLE = "riivo_varMetaUploadURI";
const META_TOKEN_VARIABLE = "riivo_varMetaAccessToken";
const META_SEND_PARAM = `varMetaURI (${META_SEND_URI_VARIABLE})`;
const META_UPLOAD_PARAM = `varMetaUploadURI (${META_UPLOAD_URI_VARIABLE})`;
const META_TOKEN_PARAM = `varMetaAccessToken (${META_TOKEN_VARIABLE})`;

/**
 * `WhatsApp - Child - Sign and Post Outbound Template Send to Bot Webhook`
 * (`5d353829`, on), called by both working references after every template
 * send — c430ace5 as `Run_Child_|_Wa_Notify`, and the house invoice child
 * 5c025055 as `Notify_Tina_Send_WhatsApp_Message`.
 *
 * It HMAC-signs the send and posts it to the conversational bot, which is how
 * an inbound reply is threaded to the outbound template that prompted it
 * rather than landing as a fresh conversation. That matters more here than
 * anywhere else: every one of the 24 approved templates ends by inviting a
 * reply ("reply here if you have any questions"), and a dunning message whose
 * answer goes nowhere is worse than no message.
 *
 * Called last and NEVER allowed to fail the touch: by the time it runs the
 * WhatsApp message has already been delivered, so failing here would roll back
 * nothing and cost the client behind them their turn. The child says the same
 * thing in its own comments, and dedupes on `sender_message_id`.
 *
 * PROMOTION HAZARD: the fourth workflowid in this file that cannot travel to
 * prod unchanged.
 */
export const NOTIFY_CHILD_FLOW_ID = "5d353829-ae5d-f111-a826-002248a29481";

/**
 * The language every bad-debt template is approved in. Read off the WABA on
 * 2026-09-11: all 24 campaign templates and the D12 fallback are `en`, and
 * Meta matches a send on name + language, so a mismatch is a rejected send
 * rather than a message in the wrong language.
 */
const TEMPLATE_LANGUAGE = "en";

/**
 * The Pay-now button's URL prefix, as Meta stores it on the approved
 * templates. Published here for ONE reason: nothing in this flow may build it.
 *
 * Meta bakes the prefix into the template at approval time and rebuilds
 * prefix + suffix itself, so the send supplies only the bare token. Passing a
 * full URL yields `https://…/p/https://…/p/token` and a dead button — the
 * single most likely thing to get wrong in this slice, which is why the button
 * reads `Compose_|_Payment_Link`'s `token` and a test asserts the `url` half
 * never reaches the WhatsApp path.
 *
 * IT IS ALSO A PROMOTION HAZARD OF A KIND CONFIGURATION CANNOT FIX. The prefix
 * is fixed per approved template, while `riivo_PaymentLink_BaseUrl` is per
 * environment, so the two can disagree and today they do:
 *
 *   - the 24 campaign templates carry `payment-link-ttt.azurewebsites.net/p/`
 *   - the D12 fallback `ttt_invoice_reminder_paylink_v2` carries
 *     `ttt-payment-link-huhhgzewb4hkdqdt.southafricanorth-01…/p/`, which IS
 *     dev's `riivo_PaymentLink_BaseUrl`
 *
 * Verified on 2026-09-11: a token minted in dev resolves on the dev host and
 * answers "Payment link not found" on the other. So in DEV a campaign-key
 * WhatsApp button cannot open its invoice however correct this flow is, and in
 * PROD the D12 button will not either until one of the two is re-approved.
 * `--check` in the deploy script compares them and says so.
 */
export const APPROVED_BUTTON_URL_PREFIX =
  "https://payment-link-ttt.azurewebsites.net/p/";

/**
 * The canary list: a JSON array of contact ids that, when non-empty, is the
 * only population this run may speak to.
 *
 * String rather than JSON type, following every other variable this build
 * reads, and parsed with `json()`. A malformed value THROWS, which fails the
 * run during selection — before a token is minted or a PDF rendered — rather
 * than silently falling back to the whole book. That is the direction an
 * allowlist must fail in: the cost of a broken restriction is an unintended
 * mass send.
 */
export const CANARY_VARIABLE = "riivo_BadDebtCanaryContactIds";
const CANARY_PARAM = `Bad Debt Canary Contact Ids (${CANARY_VARIABLE})`;

/**
 * The four verdicts the tripwire can reach. `proceed` and `canary` both run
 * the loop; `canary` additionally alerts, and is recorded as an outcome no
 * later run may use as a baseline.
 */
const VERDICT = {
  PROCEED: "proceed",
  VOLUME: "volume",
  EMPTY: "empty",
  CANARY: "canary",
} as const;

/**
 * D12: from touch 5 the ladder is exhausted, so every further touch uses one
 * already-approved general template rather than repeating the Day-40 final
 * notice or wrapping back to touch 1. Bound to the SAME environment variable
 * the cadence flow c430ace5 reads, under its exact display name, so both flows
 * follow one config value when the copy is eventually replaced by a
 * purpose-written `bad_debt_wa_ongoing`.
 */
export const ONGOING_TEMPLATE_VARIABLE = "riivo_WhatsApp_Template_WithButton";
const ONGOING_TEMPLATE_PARAM = `WhatsApp Reminder Template - With Pay-Now Button (${ONGOING_TEMPLATE_VARIABLE})`;

/** Invoice statuscode meaning the client has actually paid. */
const PAID_STATUSCODE = 958140003;

/**
 * `riivo_whatsappcommunications` option-set values, read from the entity's
 * metadata rather than copied from a flow that might itself be wrong.
 *
 * A FAILED send is logged too, which is a departure from both reference
 * flows — they write a row only on success. The reason is this campaign's own
 * rule, that a client the run went silent on always carries the reason why:
 * the run report says so for 28 days and then the run history expires, while
 * this row is the only durable place a consultant looking at the client's
 * timeline can see that a WhatsApp touch was attempted and what Meta said. One
 * row per attempt, with the status naming which happened, rather than two
 * create actions.
 */
const WA_STATUS = { SENT: 463630001, FAILED: 463630003 } as const;
const WA_DIRECTION_OUTBOUND = 463630001;
/** `riivo_failurereason` is a 1000-character string; Meta's errors are not. */
const WA_FAILURE_REASON_MAX = 900;

/**
 * `Invoice - Child - Generate PDF`, on in dev, read 2026-09-11.
 *
 * Takes `{ invoiceId }` and answers `{ pdfBase64, fileName, invoiceType }`,
 * owning both the Tax/Accounting payload construction from
 * `riivo_invoicelineitemses` and the call to `riivo_InvoiceGen2_Endpoint`. It
 * is called rather than reimplemented because that duplication is exactly what
 * the child flow exists to prevent — and because it already handles BOTH
 * invoice types, which this campaign needs: the dev book is 53 Tax to 7
 * Accounting, so a Tax-only path would silently hold every accounting debtor.
 *
 * PROMOTION HAZARD: a child flow is addressed by workflowid, and this GUID is
 * dev's. Promoting to prod means re-pointing it at prod's copy — the one line
 * in this file that cannot travel between environments unchanged.
 */
export const PDF_CHILD_FLOW_ID = "be610dd6-bf7b-f111-ab0f-000d3ada6ac0";

/**
 * The payment-link contract, all three values read from
 * `environmentvariabledefinitions` and never written down here.
 *
 * The function key in particular is stored as a plaintext default on its
 * environment variable, so a `defaultValue` on these parameters would copy a
 * live secret into this file and into every solution export of the flow. They
 * are therefore declared with EMPTY defaults: the value is the environment's
 * to supply. If the binding ever fails to resolve, the mint call fails and the
 * client is held — a visible abort, not a message carrying a dead link.
 */
const PAYMENT_LINK_BASE_URL_VARIABLE = "riivo_PaymentLink_BaseUrl";
const PAYMENT_LINK_KEY_VARIABLE = "riivo_PaymentLink_FunctionKey";
const PAYMENT_LINK_ENABLED_VARIABLE = "riivo_PaymentLinkEnabled";
const BASE_URL_PARAM = `PaymentLink_BaseUrl (${PAYMENT_LINK_BASE_URL_VARIABLE})`;
const FUNCTION_KEY_PARAM = `PaymentLink_FunctionKey (${PAYMENT_LINK_KEY_VARIABLE})`;
const LINK_ENABLED_PARAM = `Payment Link Enabled (${PAYMENT_LINK_ENABLED_VARIABLE})`;

/**
 * Throttling, handled by hand because the platform does not do it for us.
 *
 * Azure documents the retry policy as covering 408, 429 and 5xx, but says
 * nothing anywhere — error handling, limits, or the dedicated 429 page — about
 * honouring a `Retry-After` header. So the default exponential policy would
 * retry a 429 on its own schedule and ignore what the endpoint actually asked
 * for. Instead both calls carry NO retry policy and sit inside an `Until` that
 * reads the header and waits exactly that long.
 *
 * `Retry-After` is read as delta-seconds, which is what the Functions host
 * sends. An HTTP-date would fail `int()`, fail the wait, and abort that one
 * client — the safe direction, and visible in the report.
 */
const THROTTLED_STATUS = 429;
const RETRY_ATTEMPTS = 4;
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 300;

/**
 * The campaign key, as three ordered lists — the single source of truth for
 * both the 24 approved template names and the WDL that resolves one of them.
 * Deriving the flow expressions from these lists (rather than writing the
 * ladder out twice) is what stops the deployed definition and the approved
 * template set drifting apart.
 */
const AGE_BANDS = [
  { token: "30_90", underDays: 90 },
  { token: "90d_1y", underDays: 365 },
  // 3 years to the day is still chaseable; 1096 makes the bound inclusive.
  { token: "1_3y", underDays: 1096 },
] as const;

const RELATIONSHIPS = ["paid_before", "never_paid"] as const;

/** Touch 1 -> Day 0, touch 2 -> Day 10, touch 3 -> Day 25, touch 4 -> Day 40. */
const TOUCH_DAYS = [0, 10, 25, 40] as const;

/**
 * An In-scope invoice is older than 30 days and younger than three years
 * (CONTEXT.md § In-scope invoice). Neither bound is a tuning knob: under 30
 * days is too fresh for recovery outreach, and over three years is prescribed,
 * where a part-payment or acknowledgement revives the debt.
 *
 * An invoice outside the window therefore has NO age band, and a client whose
 * chased invoice falls outside it is HELD rather than banded into the nearest
 * neighbour — guessing a band would put a prescribed debt into the 1-3y
 * "final notice" copy. #98's selection query does not enforce this window, so
 * the hold is where it is caught; held rows are reported by name.
 */
const MIN_IN_SCOPE_DAYS = 30;

/** The 24 templates approved in Meta, in the seed file's order. */
export const APPROVED_CAMPAIGN_TEMPLATES: string[] = AGE_BANDS.flatMap((band) =>
  RELATIONSHIPS.flatMap((relationship) =>
    TOUCH_DAYS.map(
      (day) => `bad_debt_wa_${band.token}_${relationship}_day${day}`,
    ),
  ),
);

/** `if(a, x, if(b, y, fallback))` built from an ordered list of cases. */
const nestedIf = (
  cases: Array<[test: string, value: string]>,
  fallback: string,
) =>
  cases.reduceRight(
    (rest, [test, value]) => `if(${test}, ${value}, ${rest})`,
    fallback,
  );

/** '' when the invoice is outside the In-scope window — see MIN_IN_SCOPE_DAYS. */
const ageBandExpression = (age: string) =>
  `if(less(${age}, ${MIN_IN_SCOPE_DAYS}), '', ${nestedIf(
    AGE_BANDS.map(
      (b) => [`less(${age}, ${b.underDays})`, `'${b.token}'`] as [string, string],
    ),
    "''",
  )})`;

/** '' past touch 4, where D12 takes over rather than the ladder wrapping. */
const touchDayExpression = (touch: string) =>
  nestedIf(
    TOUCH_DAYS.map(
      (day, i) => [`equals(${touch}, ${i + 1})`, `'${day}'`] as [string, string],
    ),
    "''",
  );

/**
 * The email ladder (#102), one rung per touch, escalating exactly as the
 * campaign key does.
 *
 * KEYED ON TOUCH ONLY, not on the age band or the relationship. The 24
 * WhatsApp templates are keyed on all three because Meta approves each variant
 * separately and the band is baked into copy that cannot be assembled at send
 * time. Email has no such constraint, and a 5 x 2 x 3 matrix of hand-written
 * paragraphs is thirty pieces of copy to keep in step with one another for a
 * distinction the reader of a single message cannot perceive. The band still
 * decides which WhatsApp template goes out; on email it decides nothing, and
 * saying so here is cheaper than a comment on every rung.
 *
 * The wording of the closing paragraph and of the final notice is taken from
 * the live cadence flow c430ace5 rather than written fresh: that copy is
 * already in front of clients, so matching it keeps the two dunning voices
 * from diverging, and the final notice in particular is the sentence with
 * consequences attached.
 *
 * `{invoice}` and `{amount}` are the only substitutions. Apostrophes are
 * escaped into the WDL literal by `copyExpression`, but the copy avoids them
 * anyway — a quote inside a generated expression is the kind of thing that
 * only fails once it is deployed.
 */
type EmailCopy = { subject: string; paragraph: string };

const EMAIL_LADDER: EmailCopy[] = [
  {
    subject: "Outstanding account: invoice {invoice}",
    paragraph:
      "<p>Our records show that invoice <strong>{invoice}</strong> has not been settled, and <strong>R {amount}</strong> remains outstanding on your account.</p>",
  },
  {
    subject: "Reminder: invoice {invoice} is still outstanding",
    paragraph:
      "<p>We have not yet received payment of <strong>R {amount}</strong> on invoice <strong>{invoice}</strong>. We would appreciate settlement, or a call to arrange terms, at your earliest convenience.</p>",
  },
  {
    subject: "Urgent: overdue invoice {invoice}",
    paragraph:
      "<p>Invoice <strong>{invoice}</strong> is now significantly overdue. An amount of <strong>R {amount}</strong> remains outstanding and requires your urgent attention.</p>",
  },
  {
    subject: "Final notice: invoice {invoice}",
    paragraph:
      "<p>This is a <strong>final notice</strong> regarding invoice <strong>{invoice}</strong>, which has an outstanding balance of <strong>R {amount}</strong>. If the account is not settled, it will be handed over for further collections action.</p>",
  },
];

/**
 * D12 on email: past the ladder, one general reminder that keeps going.
 *
 * Softer than the final notice it follows, which is the same accepted
 * departure D12 makes on WhatsApp — the alternative is either repeating a
 * final notice that has visibly not been acted on, or wrapping back to an
 * opening message after one.
 */
const EMAIL_ONGOING: EmailCopy = {
  subject: "Outstanding invoice {invoice}",
  paragraph:
    "<p>Invoice <strong>{invoice}</strong> remains unpaid, with <strong>R {amount}</strong> outstanding. Please settle the account, or contact us so we can arrange terms with you.</p>",
};

/** The second paragraph of every rung — the attachment and the POP ask. */
const EMAIL_CLOSING_PARAGRAPH =
  "<p>Your invoice is attached for your records, including our banking details for EFT payment. If you have already settled this account, kindly send us your proof of payment so we can update our records.</p>";

/** A WDL string literal: single quotes double, as WDL escapes them. */
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** Copy carrying {invoice} and {amount}, as a WDL concat() over both. */
const copyExpression = (text: string, invoice: string, amount: string) => {
  const parts = text
    .split(/(\{invoice\}|\{amount\})/)
    .filter((part) => part !== "")
    .map((part) =>
      part === "{invoice}"
        ? invoice
        : part === "{amount}"
          ? amount
          : literal(part),
    );
  return parts.length === 1 ? parts[0] : `concat(${parts.join(", ")})`;
};

/** Rung N for touches 1..4, the D12 copy for anything past them. */
const ladderExpression = (
  field: keyof EmailCopy,
  touch: string,
  invoice: string,
  amount: string,
) =>
  nestedIf(
    EMAIL_LADDER.map(
      (copy, i) =>
        [
          `equals(${touch}, ${i + 1})`,
          copyExpression(copy[field], invoice, amount),
        ] as [string, string],
    ),
    copyExpression(EMAIL_ONGOING[field], invoice, amount),
  );

/**
 * What Meta refuses inside a template parameter, and how it is removed (#103).
 *
 * A template parameter may not contain a newline, a tab, or four consecutive
 * spaces. Nothing upstream sanitises for this, and the failure mode is the
 * quiet kind: Meta rejects the send with a 400 rather than producing an
 * obviously broken message, so one client goes silent for a reason that never
 * appears near the name that caused it.
 *
 * The characters are written as `decodeUriComponent('%0A')` rather than as
 * literals because a raw newline inside a WDL string literal survives neither
 * this file nor the JSON round-trip to Dataverse legibly, and a control
 * character nobody can see in a diff is exactly the wrong thing to depend on.
 *
 * Four spaces collapse to one, THREE TIMES: `replace` is single-pass and
 * non-overlapping, so one pass turns 16 spaces into 4 — still illegal. Three
 * passes cover a run of 64, well past anything a contact name can hold; past
 * that the runtime gate below holds the client instead of sending something
 * Meta will bounce.
 */
const META_FORBIDDEN = {
  NEWLINE: "decodeUriComponent('%0A')",
  CARRIAGE_RETURN: "decodeUriComponent('%0D')",
  TAB: "decodeUriComponent('%09')",
  FOUR_SPACES: "'    '",
} as const;

const SPACE_COLLAPSE_PASSES = 3;

/** A value made safe to hand Meta as a template parameter. */
const metaParameter = (value: string) => {
  let expression = value;
  for (const character of [
    META_FORBIDDEN.NEWLINE,
    META_FORBIDDEN.CARRIAGE_RETURN,
    META_FORBIDDEN.TAB,
  ]) {
    expression = `replace(${expression}, ${character}, ' ')`;
  }
  for (let pass = 0; pass < SPACE_COLLAPSE_PASSES; pass++) {
    expression = `replace(${expression}, ${META_FORBIDDEN.FOUR_SPACES}, ' ')`;
  }
  return `trim(${expression})`;
};

/**
 * A filename safe to put inside a `Content-Disposition` header.
 *
 * A double quote or a backslash ends the quoted field early, which is the
 * multipart equivalent of the hand-built JSON #102 refused to write — and, as
 * there, the input is a filename this flow does not generate. Both are named
 * by code point (`%22`, `%5C`) so that neither this file nor the deployed JSON
 * depends on an escape whose meaning differs between the two.
 */
const fileNameExpression = (value: string) => {
  let expression = value;
  for (const character of [
    "decodeUriComponent('%22')",
    "decodeUriComponent('%5C')",
    META_FORBIDDEN.NEWLINE,
    META_FORBIDDEN.CARRIAGE_RETURN,
    META_FORBIDDEN.TAB,
  ]) {
    expression = `replace(${expression}, ${character}, '')`;
  }
  return `trim(${expression})`;
};

/** Asserted rather than assumed: what a clean parameter must not contain. */
const metaParameterClean = (value: string) =>
  `and(not(contains(${value}, ${META_FORBIDDEN.NEWLINE})), not(contains(${value}, ${META_FORBIDDEN.CARRIAGE_RETURN})), not(contains(${value}, ${META_FORBIDDEN.TAB})), not(contains(${value}, ${META_FORBIDDEN.FOUR_SPACES})), not(empty(${value})))`;

/**
 * The body parameters each template family takes, read off the WABA on
 * 2026-09-11 rather than assumed from the issue.
 *
 * THE TWO FAMILIES DISAGREE, and #99 could not have known: the 24 campaign
 * templates are `Hi {{1}}, … Amount due: {{2}}` — name and amount — while the
 * D12 fallback `ttt_invoice_reminder_paylink_v2` is `Hi {{1}}, … invoice
 * *{{2}}* … balance of *{{3}}*` and takes the invoice number in the middle.
 * Sending two parameters to a three-parameter template is a 400 from Meta, so
 * a client reaching touch 5 would have gone silent the first time the ladder
 * ran out — months after the code that caused it shipped.
 *
 * The amount carries its own "R" because the templates do not: `Amount due:
 * {{2}}` renders exactly what is passed.
 */
const CAMPAIGN_BODY_PARAMETERS = ["Wa_Name", "Wa_Amount"] as const;
const ONGOING_BODY_PARAMETERS = [
  "Wa_Name",
  "Wa_Invoice",
  "Wa_Amount",
] as const;

/** One `{ type: "text", text: … }` per compose, in template order. */
const textParameters = (composes: readonly string[]) =>
  composes.map((compose) => ({
    type: "text",
    text: `@{outputs('Compose_|_${compose}')}`,
  }));

const DATAVERSE = {
  connectionName: "shared_commondataserviceforapps",
  apiId: "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
} as const;

/**
 * Chaseable invoice statuscodes.
 *
 * Six exist, and filtering on `statecode eq 0` alone — as the live
 * `Invoice - Scheduled - Send Overdue Payment SMS Reminders...` flow still
 * does — sweeps in Payment Received – Pending Settlement, i.e. clients whose
 * money is already in flight. Partially Paid is chaseable and is absent from
 * every pre-2026-09 document on this campaign.
 */
const CHASEABLE_STATUSCODES = [
  958140000, // Open
  463630001, // Partially Paid
] as const;

const contact = (field: string) =>
  `outputs('Get_|_Payer_Contact')?['body/${field}']`;

/** One row of `varSelected` — a client, and the invoice this run chases. */
const selected = (field: string) =>
  `items('Apply_to_each_|_Selected')?['${field}']`;

const dataverse = (operationId: string, parameters: Record<string, unknown>) => ({
  type: "OpenApiConnection",
  inputs: {
    host: { ...DATAVERSE, operationId },
    parameters,
    authentication: "@parameters('$authentication')",
  },
});

/** A field of the current `varSelected` row, as a flow expression. */
const selectedValue = (field: string) => `@${selected(field)}`;

/**
 * The touch, written back onto `riivo_baddebt`.
 *
 * MONOTONIC BY CONSTRUCTION, because a blind overwrite has already erased a
 * run's figures on this table once. Three things make it so:
 *  - the new count is `read + 1`, never a recount, so a concurrent writer's
 *    increment is lost at worst and never reversed;
 *  - `riivo_campaignfirstsent` is written on the first touch only, from a
 *    separate branch, so a later touch's patch cannot carry it at all;
 *  - `riivo_campaignbounced` and `riivo_campaignlastreply` are owned by the
 *    bounce and reply paths and are absent from both patches.
 */
const touchUpdate = (isFirstTouch: boolean) => ({
  runAfter: {},
  ...dataverse("UpdateRecord", {
    entityName: "riivo_baddebts",
    recordId: selectedValue("badDebtId"),
    "item/riivo_campaignsendcount": "@outputs('Compose_|_Touch_Number')",
    "item/riivo_campaignlastsent": "@utcNow()",
    ...(isFirstTouch ? { "item/riivo_campaignfirstsent": "@utcNow()" } : {}),
  }),
});

/**
 * A client this run deliberately says nothing to, and why.
 *
 * Both hold paths report the same shape — a template that is not approved, and
 * a token or document that could not be produced — so "who was silent today,
 * and what stopped them" is one list to read rather than two.
 */
const heldRow = (reason: string) => ({
  runAfter: {},
  type: "AppendToArrayVariable",
  inputs: {
    name: "varHeld",
    value: {
      badDebtId: selectedValue("badDebtId"),
      clientId: selectedValue("clientId"),
      invoiceId: selectedValue("invoiceId"),
      invoiceNumber: selectedValue("invoiceNumber"),
      ageDays: "@outputs('Compose_|_Invoice_Age_Days')",
      ageBand: "@outputs('Compose_|_Age_Band')",
      touch: "@outputs('Compose_|_Touch_Number')",
      templateName: "@outputs('Compose_|_Template_Name')",
      reason,
    },
  },
});

/** Foreach concurrency cap. R8: uncapped loops trip service-protection limits. */
const capped = { concurrency: { repetitions: 1 } };

/** Seconds the endpoint asked us to wait, clamped to something sane. */
const retryAfterSeconds = (call: string) =>
  `@min(max(int(coalesce(outputs('${call}')?['headers']?['Retry-After'], outputs('${call}')?['headers']?['retry-after'], '${DEFAULT_RETRY_AFTER_SECONDS}')), 1), ${MAX_RETRY_AFTER_SECONDS})`;

/**
 * One call, retried only while the endpoint answers 429, waiting for as long
 * as its `Retry-After` says.
 *
 * The call itself is allowed to FAIL inside the loop — a 429 is a failed HTTP
 * action — and the status compose handles that failure, so the iteration ends
 * Succeeded and the `Until` is free to go round again. Every other outcome,
 * success or hard failure, sets the done flag on the first pass. Whether a
 * call actually produced anything is NOT decided here: it is decided by
 * `Compose_|_Prepare_Ok` reading the outputs, so a call that failed for any
 * reason and a call that returned nothing useful abort the client identically.
 *
 * The done flag is a flow-level variable because Power Automate only allows
 * variables to be initialised at the top level. That is safe solely because
 * `Apply_to_each_|_Selected` runs one repetition at a time — the same
 * sequential-loop assumption the candidate arrays already rest on.
 */
const untilNotThrottled = ({
  slug,
  variable,
  call,
  callAction,
  runAfter,
}: {
  slug: string;
  variable: string;
  call: string;
  callAction: Record<string, unknown>;
  runAfter: Record<string, string[]>;
}) => ({
  [`Set_variable_|_${slug}_Pending`]: {
    runAfter,
    type: "SetVariable",
    inputs: { name: variable, value: false },
  },
  [`Until_|_${slug}`]: {
    runAfter: { [`Set_variable_|_${slug}_Pending`]: ["Succeeded"] },
    type: "Until",
    expression: `@equals(variables('${variable}'), true)`,
    limit: { count: RETRY_ATTEMPTS, timeout: "PT5M" },
    actions: {
      [call]: { runAfter: {}, ...callAction },
      [`Compose_|_${slug}_Status`]: {
        // Succeeded, Failed AND TimedOut: a 429 arrives as a failed action, and
        // reading its status is the whole point of this loop.
        runAfter: { [call]: ["Succeeded", "Failed", "TimedOut"] },
        type: "Compose",
        inputs: `@coalesce(outputs('${call}')?['statusCode'], 0)`,
      },
      [`Condition_|_${slug}_Throttled`]: {
        runAfter: { [`Compose_|_${slug}_Status`]: ["Succeeded"] },
        type: "If",
        expression: {
          and: [
            { equals: [`@outputs('Compose_|_${slug}_Status')`, THROTTLED_STATUS] },
          ],
        },
        actions: {
          [`Delay_|_${slug}_Retry_After`]: {
            runAfter: {},
            type: "Wait",
            inputs: {
              interval: { count: retryAfterSeconds(call), unit: "Second" },
            },
          },
        },
        else: { actions: {} },
      },
      // Last, and always Succeeded, so the loop body never fails the scope.
      [`Set_variable_|_${slug}_Done`]: {
        runAfter: { [`Condition_|_${slug}_Throttled`]: ["Succeeded"] },
        type: "SetVariable",
        inputs: {
          name: variable,
          value: `@not(equals(outputs('Compose_|_${slug}_Status'), ${THROTTLED_STATUS}))`,
        },
      },
    },
  },
});

export function buildBadDebtRecoveryTouchesFlow() {
  // ---------------------------------------------- #101: the run-level brake ----
  const selectedCount = "outputs('Compose_|_Selected_Count')";
  const previousCount = "outputs('Compose_|_Previous_Count')";
  const changePercent = "outputs('Compose_|_Volume_Change_Percent')";
  const thresholdPercent = "outputs('Compose_|_Volume_Threshold_Percent')";
  const verdict = "outputs('Compose_|_Tripwire_Verdict')";

  /**
   * Only a run that was ACTED ON is a baseline — see `RUN_OUTCOME`. Reading
   * the last run whatever its outcome would let one abort disarm the tripwire:
   * a tenfold selection would park once, record tenfold, and sail through next
   * time.
   */
  const baselineFilter = `statecode eq 0 and (${BASELINE_OUTCOMES.map(
    (outcome) => `riivo_outcome eq '${outcome}'`,
  ).join(" or ")})`;

  /**
   * Order is the whole logic. No baseline proceeds (a first run must not
   * deadlock); an empty selection is then caught BEFORE the proportional test,
   * because a drop to zero is also a 100% move and "selected nobody" is the
   * more useful thing to be told. A zero baseline proceeds: there is no
   * proportion of zero, and a run following one that legitimately selected
   * nobody is the ordinary restart case.
   */
  const verdictExpression = nestedIf(
    [
      // First, and short-circuiting every volume test below it: a run
      // restricted to a named handful is anomalous BY CONSTRUCTION, so
      // measuring it against a full-book baseline could only ever park it.
      ["outputs('Compose_|_Canary_Active')", `'${VERDICT.CANARY}'`],
      ["not(outputs('Compose_|_Has_Previous_Run'))", `'${VERDICT.PROCEED}'`],
      [
        `and(equals(${selectedCount}, 0), greater(${previousCount}, 0))`,
        `'${VERDICT.EMPTY}'`,
      ],
      [`equals(${previousCount}, 0)`, `'${VERDICT.PROCEED}'`],
      [
        `greater(${changePercent}, ${thresholdPercent})`,
        `'${VERDICT.VOLUME}'`,
      ],
    ],
    `'${VERDICT.PROCEED}'`,
  );

  /** The sentence the alert email, the run record and the run error all carry. */
  const reasonExpression = nestedIf(
    [
      [
        `equals(${verdict}, '${VERDICT.VOLUME}')`,
        `concat('selected ', string(${selectedCount}), ' clients against ', string(${previousCount}), ' in the last acted-on run - a ', string(${changePercent}), '% move, past the ', string(${thresholdPercent}), '% threshold')`,
      ],
      [
        `equals(${verdict}, '${VERDICT.EMPTY}')`,
        `concat('selected no clients at all, against ', string(${previousCount}), ' in the last acted-on run')`,
      ],
    ],
    "''",
  );

  const invoiceScopeFilter =
    "@concat('new_invoicesid eq ', items('Apply_to_each_|_BadDebt')?['_riivo_invoice_value']" +
    `, ' and statecode eq 0 and (statuscode eq ${CHASEABLE_STATUSCODES[0]}` +
    ` or statuscode eq ${CHASEABLE_STATUSCODES[1]}) and ttt_outstanding gt 0')`;

  return {
    properties: {
      connectionReferences: {
        shared_commondataserviceforapps: {
          runtimeSource: "embedded",
          connection: { connectionReferenceLogicalName: "riivo_dataverse" },
          api: { name: "shared_commondataserviceforapps" },
        },
      },
      definition: {
        $schema:
          "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
        contentVersion: "1.0.0.0",
        parameters: {
          $authentication: { defaultValue: {}, type: "SecureObject" },
          $connections: { defaultValue: {}, type: "Object" },
          [TEST_MODE_PARAM]: {
            defaultValue: "true",
            type: "String",
            metadata: {
              schemaName: "riivo_ReminderTestMode",
              description:
                "When 'true' the run reports its selection and stops. This slice (#98) sends nothing in either mode; the switch is wired now so the send slices inherit it rather than bolting it on.",
            },
          },
          [TOUCH_GAP_PARAM]: {
            defaultValue: "2",
            type: "String",
            metadata: {
              schemaName: TOUCH_GAP_VARIABLE,
              description:
                "Minimum whole days between two touches to the same bad-debt record. Guards the Monday/Thursday cadence against a same-day re-run or a Power Automate retry, which would otherwise double-send: there are no transactions here, so this recency test is the only duplicate defence. Default 2 blocks same-day and next-day repeats while leaving the 3-day Mon->Thu gap intact.",
            },
          },
          [ONGOING_TEMPLATE_PARAM]: {
            defaultValue: "ttt_invoice_reminder_paylink_v2",
            type: "String",
            metadata: {
              schemaName: "riivo_WhatsApp_Template_WithButton",
              description:
                "D12: the template used from touch 5, once the four campaign-key touches are spent. Already approved with a Pay-now button, so no Meta submission blocks the cadence going unattended. Its copy is a general reminder rather than an arrears notice, so firmness softens after the Day-40 final notice - accepted, and swappable for a purpose-written bad_debt_wa_ongoing by changing this variable alone.",
            },
          },
          [VOLUME_THRESHOLD_PARAM]: {
            defaultValue: String(DEFAULT_VOLUME_THRESHOLD_PERCENT),
            type: "String",
            metadata: {
              schemaName: VOLUME_THRESHOLD_VARIABLE,
              description:
                "How far the selected client count may move from the last acted-on run before the run parks itself instead of sending, as a whole-number percentage in either direction. 40 is the figure R5 of the spec recommends. Raise it to accept a genuinely larger book; to bless one run only, set that parked run's riivo_outcome to 'accepted' instead, which does not leave a loosened threshold behind.",
            },
          },
          [CANARY_PARAM]: {
            defaultValue: "",
            type: "String",
            metadata: {
              schemaName: CANARY_VARIABLE,
              description:
                "A JSON array of contact ids, e.g. [\"26372e5b-...\",\"50334bea-...\"]. While it is non-empty the run speaks ONLY to those clients: the list narrows the selection query itself, so nobody else is fetched, minted for or rendered for. Empty (the normal state) means the whole book. Used to rehearse on colleagues and then to canary on a handful of real clients before the channel is trusted. A canary run skips the volume tripwire and is recorded as outcome 'canary', which no later run may use as a baseline - and it emails the team every time, because an allowlist left set is a campaign that silently speaks to three people forever. CLEAR IT when the canary is done.",
            },
          },
          [SENDER_USER_PARAM]: {
            defaultValue: "",
            type: "String",
            metadata: {
              schemaName: SENDER_USER_VARIABLE,
              description:
                "The systemuser the branded-email child is handed. With variant System the message is actually FROM the service queue, but the child validates this value and reads that user, so it must be a real, enabled one. Empty default: a user id is environment-specific, and a dev id travelling to prod would fail there rather than here.",
            },
          },
          [SEND_EMAIL_PARAM]: {
            defaultValue: false,
            type: "Bool",
            metadata: {
              schemaName: SEND_EMAIL_VARIABLE,
              description:
                "The org-wide send switch the branded-email child obeys: with it off, every caller's mail is created and saved as a draft instead of being sent. Read here only so the run report can say which happened - a rehearsal that produced drafts otherwise looks exactly like one that failed. Nothing in this flow branches on it; the child's own 'sent' answer is what gates the touch bookkeeping, so an unsent draft advances no counter either way.",
            },
          },
          // Empty defaults on all three, for the same reason the payment-link
          // parameters carry them: the values belong to the environment, and
          // one of them is a live bearer token that must never be written into
          // a flow definition or a solution export.
          [META_SEND_PARAM]: {
            defaultValue: "",
            type: "String",
            metadata: {
              schemaName: META_SEND_URI_VARIABLE,
              description:
                "Meta Cloud API messages endpoint for TTT's WhatsApp Business number. There is ONE such number and Meta offers no sandbox of it, so this value is the same in dev and prod: a run that sends here sends a real message from the live business number. Test mode and riivo_BadDebtCanaryContactIds are the only things between a run and a client's handset - there is no draft mode for WhatsApp the way riivo_SendEmail gives one for email.",
            },
          },
          [META_UPLOAD_PARAM]: {
            defaultValue: "",
            type: "String",
            metadata: {
              schemaName: META_UPLOAD_URI_VARIABLE,
              description:
                "Meta Cloud API media endpoint. The invoice PDF is uploaded here per recipient and the returned media id becomes the template's document header, which is how the client receives the invoice itself rather than a link to it.",
            },
          },
          [META_TOKEN_PARAM]: {
            defaultValue: "",
            type: "String",
            metadata: {
              schemaName: META_TOKEN_VARIABLE,
              description:
                "Bearer token for both Meta calls. Held as a plaintext default on its environment variable, which is worth reviewing separately alongside riivo_PaymentLink_FunctionKey; it is never written into a flow definition.",
            },
          },
          [ENVIRONMENT_ADDRESS_PARAM]: {
            defaultValue: "",
            type: "String",
            metadata: {
              schemaName: ENVIRONMENT_ADDRESS_VARIABLE,
              description:
                "Org address, passed to the failed-flow alert child so the email names which environment parked the run. Empty default: the value belongs to the environment, and an alert that says 'dev' while running in prod is worse than one that says nothing.",
            },
          },
          // Empty defaults on all three: the values belong to the environment,
          // and the key is a live secret that must never reach this file.
          [BASE_URL_PARAM]: {
            defaultValue: "",
            type: "String",
            metadata: {
              schemaName: PAYMENT_LINK_BASE_URL_VARIABLE,
              description:
                "Base URL of the payment-link function app. Two things are built from it and nothing else: the POST {base}/mint-token endpoint, and the client-facing {base}/p/{token} link.",
            },
          },
          [FUNCTION_KEY_PARAM]: {
            defaultValue: "",
            type: "String",
            metadata: {
              schemaName: PAYMENT_LINK_KEY_VARIABLE,
              description:
                "Function key sent as the x-functions-key header when minting. Held as a plaintext default on the environment variable, which is worth reviewing separately; it is never written into a flow definition.",
            },
          },
          [LINK_ENABLED_PARAM]: {
            defaultValue: true,
            type: "Bool",
            metadata: {
              schemaName: PAYMENT_LINK_ENABLED_VARIABLE,
              description:
                "Master switch for payment links, honoured here exactly as the cadence flow c430ace5 honours it. Every one of the 24 approved bad-debt templates carries a Pay-now button, so with links off there is no compliant message to send: the run holds each client with that reason rather than sending a button pointing at a switched-off endpoint.",
            },
          },
        },
        triggers: {
          Recurrence: {
            type: "Recurrence",
            recurrence: {
              frequency: "Week",
              interval: 1,
              timeZone: "South Africa Standard Time",
              schedule: {
                weekDays: ["Monday", "Thursday"],
                hours: ["9"],
                // 09:45, not 09:30 — see the lineage note above.
                minutes: [45],
              },
            },
          },
        },
        actions: {
          "Compose_|_TestMode": {
            runAfter: {},
            type: "Compose",
            inputs: `@equals(toLower(trim(coalesce(parameters('${TEST_MODE_PARAM}'), 'true'))), 'true')`,
          },

          // The 24 names approved in Meta. A resolved name is checked against
          // this list before it is reported as sendable, so a band or
          // relationship token that drifts produces a HELD row naming the
          // unapproved template rather than a send Meta would reject.
          "Compose_|_Approved_Templates": {
            runAfter: { "Compose_|_TestMode": ["Succeeded"] },
            type: "Compose",
            inputs: APPROVED_CAMPAIGN_TEMPLATES,
          },

          // sub(0, n) rather than a negative literal, so the gap is only ever
          // read from the environment variable.
          "Compose_|_Last_Sent_Cutoff": {
            runAfter: { "Compose_|_Approved_Templates": ["Succeeded"] },
            type: "Compose",
            inputs: `@addDays(utcNow(), sub(0, int(coalesce(parameters('${TOUCH_GAP_PARAM}'), '2'))), 'yyyy-MM-ddTHH:mm:ssZ')`,
          },

          // ---- #102: the canary list, applied to the QUERY ----
          // Same principle as the cadence guard above: a client who is not on
          // the list is never FETCHED, so no later branch can act on them by
          // accident. json() on a malformed value throws and ends the run
          // here, before anything has been minted or rendered — the only safe
          // direction for a restriction whose failure mode is a mass send.
          "Compose_|_Canary_Ids": {
            runAfter: { "Compose_|_Last_Sent_Cutoff": ["Succeeded"] },
            type: "Compose",
            inputs: `@if(empty(trim(coalesce(parameters('${CANARY_PARAM}'), ''))), json('[]'), json(trim(parameters('${CANARY_PARAM}'))))`,
          },
          "Compose_|_Canary_Active": {
            runAfter: { "Compose_|_Canary_Ids": ["Succeeded"] },
            type: "Compose",
            inputs: "@greater(length(outputs('Compose_|_Canary_Ids')), 0)",
          },
          // WDL expressions have join() but no map, so the clauses are built
          // by a Select action rather than inline.
          "Select_|_Canary_Clauses": {
            runAfter: { "Compose_|_Canary_Active": ["Succeeded"] },
            type: "Select",
            inputs: {
              from: "@outputs('Compose_|_Canary_Ids')",
              select: "@concat('_riivo_client_value eq ', item())",
            },
          },
          "Compose_|_Canary_Filter": {
            runAfter: { "Select_|_Canary_Clauses": ["Succeeded"] },
            type: "Compose",
            inputs:
              "@if(outputs('Compose_|_Canary_Active'), concat(' and (', join(body('Select_|_Canary_Clauses'), ' or '), ')'), '')",
          },

          "Initialize_variable_|_Candidates": {
            runAfter: { "Compose_|_Canary_Filter": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: {
              variables: [{ name: "varCandidates", type: "array", value: [] }],
            },
          },

          // The cadence guard lives in the QUERY, not in a downstream
          // condition: a record that is too recent is never fetched, so no
          // later branch can accidentally act on it.
          "List_rows_|_Open_BadDebts": {
            runAfter: { "Initialize_variable_|_Candidates": ["Succeeded"] },
            ...dataverse("ListRecords", {
              entityName: "riivo_baddebts",
              $select:
                "riivo_baddebtid,_riivo_invoice_value,_riivo_client_value,riivo_campaignlastsent,riivo_campaignsendcount,riivo_campaignfirstsent,riivo_outstandingamount",
              $filter:
                "@concat('statecode eq 0 and (riivo_campaignlastsent eq null or riivo_campaignlastsent lt ', outputs('Compose_|_Last_Sent_Cutoff'), ')', outputs('Compose_|_Canary_Filter'))",
            }),
          },

          "Apply_to_each_|_BadDebt": {
            foreach: "@outputs('List_rows_|_Open_BadDebts')?['body/value']",
            runAfter: { "List_rows_|_Open_BadDebts": ["Succeeded"] },
            type: "Foreach",
            runtimeConfiguration: capped,
            actions: {
              // Fetched as a filtered list rather than GetItem-by-id so an
              // invoice that has since been paid, cancelled or moved to
              // pending settlement returns an empty set and is skipped —
              // GetItem would have to succeed and then be re-checked.
              "List_rows_|_Invoice_In_Scope": {
                runAfter: {},
                ...dataverse("ListRecords", {
                  entityName: "new_invoiceses",
                  // riivo_paymenttoken is read HERE rather than re-fetched at
                  // mint time: an invoice that already has a token must not be
                  // re-minted, and the cheapest way to guarantee that is to
                  // carry the answer from the query that already ran.
                  $select:
                    "new_invoicesid,new_name,createdon,ttt_outstanding,_ttt_customer_value,riivo_paymenttoken,riivo_paymentlinksenton",
                  $filter: invoiceScopeFilter,
                  $top: 1,
                }),
              },

              "Condition_|_Invoice_In_Scope": {
                runAfter: { "List_rows_|_Invoice_In_Scope": ["Succeeded"] },
                type: "If",
                expression: {
                  and: [
                    {
                      greater: [
                        "@length(outputs('List_rows_|_Invoice_In_Scope')?['body/value'])",
                        0,
                      ],
                    },
                    {
                      not: {
                        equals: [
                          "@coalesce(items('Apply_to_each_|_BadDebt')?['_riivo_client_value'], '')",
                          "",
                        ],
                      },
                    },
                  ],
                },
                actions: {
                  "Get_|_Payer_Contact": {
                    runAfter: {},
                    ...dataverse("GetItem", {
                      entityName: "contacts",
                      recordId:
                        "@items('Apply_to_each_|_BadDebt')?['_riivo_client_value']",
                    }),
                  },

                  // Polarity is copied verbatim from the proven cadence flow
                  // c430ace5 and is INVERTED between the two channels:
                  //   donotemail / donotbulkemail TRUE  => suppressed
                  //   riivo_whatsappoptinout      TRUE  => opted IN
                  // Both default to "contactable" when null, matching c430ace5.
                  "Compose_|_Email_Allowed": {
                    runAfter: { "Get_|_Payer_Contact": ["Succeeded"] },
                    type: "Compose",
                    inputs: `@and(not(empty(coalesce(${contact("emailaddress1")}, ''))), not(equals(coalesce(${contact("donotemail")}, false), true)), not(equals(coalesce(${contact("donotbulkemail")}, false), true)))`,
                  },
                  "Compose_|_Wa_Allowed": {
                    runAfter: { "Get_|_Payer_Contact": ["Succeeded"] },
                    type: "Compose",
                    inputs: `@and(not(empty(coalesce(${contact("icon_formattedmobilenumber")}, ''))), equals(coalesce(${contact("riivo_whatsappoptinout")}, true), true))`,
                  },

                  // OR, not AND: a client suppressed on one channel is still
                  // selected for the other. Only a client with both channels
                  // closed drops out of the run.
                  "Condition_|_Any_Channel_Allowed": {
                    runAfter: {
                      "Compose_|_Email_Allowed": ["Succeeded"],
                      "Compose_|_Wa_Allowed": ["Succeeded"],
                    },
                    type: "If",
                    expression: {
                      or: [
                        { equals: ["@outputs('Compose_|_Email_Allowed')", true] },
                        { equals: ["@outputs('Compose_|_Wa_Allowed')", true] },
                      ],
                    },
                    actions: {
                      "Append_to_array_variable_|_Candidate": {
                        runAfter: {},
                        type: "AppendToArrayVariable",
                        inputs: {
                          name: "varCandidates",
                          value: {
                            badDebtId:
                              "@items('Apply_to_each_|_BadDebt')?['riivo_baddebtid']",
                            clientId:
                              "@items('Apply_to_each_|_BadDebt')?['_riivo_client_value']",
                            invoiceId:
                              "@first(outputs('List_rows_|_Invoice_In_Scope')?['body/value'])?['new_invoicesid']",
                            invoiceNumber:
                              "@first(outputs('List_rows_|_Invoice_In_Scope')?['body/value'])?['new_name']",
                            outstanding:
                              "@first(outputs('List_rows_|_Invoice_In_Scope')?['body/value'])?['ttt_outstanding']",
                            // Ticks, because WDL has no sort: "newest" is
                            // resolved by max() over a comparable integer.
                            invoiceTicks:
                              "@ticks(first(outputs('List_rows_|_Invoice_In_Scope')?['body/value'])?['createdon'])",
                            // Carried as the ISO date too: the age band is
                            // computed from it, and a human diffing the dry-run
                            // report can read it.
                            invoiceCreatedOn:
                              "@first(outputs('List_rows_|_Invoice_In_Scope')?['body/value'])?['createdon']",
                            paymentToken:
                              "@coalesce(first(outputs('List_rows_|_Invoice_In_Scope')?['body/value'])?['riivo_paymenttoken'], '')",
                            paymentLinkSentOn:
                              "@coalesce(first(outputs('List_rows_|_Invoice_In_Scope')?['body/value'])?['riivo_paymentlinksenton'], '')",
                            // Touch state, read once here so template
                            // resolution and the increment share one value.
                            sendCount:
                              "@coalesce(items('Apply_to_each_|_BadDebt')?['riivo_campaignsendcount'], 0)",
                            firstSent:
                              "@coalesce(items('Apply_to_each_|_BadDebt')?['riivo_campaignfirstsent'], '')",
                            emailAllowed: "@outputs('Compose_|_Email_Allowed')",
                            whatsAppAllowed: "@outputs('Compose_|_Wa_Allowed')",
                            // Carried from the contact read that already
                            // happened, so the send loop needs no second
                            // GetItem to greet somebody by name. 'there' is
                            // the same fallback c430ace5 uses.
                            firstName: `@coalesce(${contact("firstname")}, 'there')`,
                            // Same reasoning as firstName, and the same read:
                            // the WhatsApp send needs the number this consent
                            // test already looked at, so carrying it costs
                            // nothing and a second GetItem per client in the
                            // send loop would cost one call each (#103).
                            mobile: `@coalesce(${contact("icon_formattedmobilenumber")}, '')`,
                          },
                        },
                      },
                    },
                    else: { actions: {} },
                  },
                },
                else: { actions: {} },
              },
            },
          },

          // ---- collapse to one row per client (D3/D10: keep the newest) ----
          "Select_|_Client_Ids": {
            runAfter: { "Apply_to_each_|_BadDebt": ["Succeeded"] },
            type: "Select",
            inputs: {
              from: "@variables('varCandidates')",
              select: "@item()['clientId']",
            },
          },
          "Compose_|_Distinct_Clients": {
            runAfter: { "Select_|_Client_Ids": ["Succeeded"] },
            type: "Compose",
            inputs:
              "@union(body('Select_|_Client_Ids'), body('Select_|_Client_Ids'))",
          },
          "Initialize_variable_|_Selected": {
            runAfter: { "Compose_|_Distinct_Clients": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: {
              variables: [{ name: "varSelected", type: "array", value: [] }],
            },
          },

          "Apply_to_each_|_Client": {
            foreach: "@outputs('Compose_|_Distinct_Clients')",
            runAfter: { "Initialize_variable_|_Selected": ["Succeeded"] },
            type: "Foreach",
            runtimeConfiguration: capped,
            actions: {
              "Filter_|_Client_Rows": {
                runAfter: {},
                type: "Query",
                inputs: {
                  from: "@variables('varCandidates')",
                  where:
                    "@equals(item()['clientId'], items('Apply_to_each_|_Client'))",
                },
              },
              "Select_|_Client_Ticks": {
                runAfter: { "Filter_|_Client_Rows": ["Succeeded"] },
                type: "Select",
                inputs: {
                  from: "@body('Filter_|_Client_Rows')",
                  select: "@item()['invoiceTicks']",
                },
              },
              "Compose_|_Newest_Ticks": {
                runAfter: { "Select_|_Client_Ticks": ["Succeeded"] },
                type: "Compose",
                inputs: "@max(body('Select_|_Client_Ticks'))",
              },
              "Filter_|_Newest_Row": {
                runAfter: { "Compose_|_Newest_Ticks": ["Succeeded"] },
                type: "Query",
                inputs: {
                  from: "@body('Filter_|_Client_Rows')",
                  where:
                    "@equals(item()['invoiceTicks'], outputs('Compose_|_Newest_Ticks'))",
                },
              },
              "Compose_|_Selected_For_Client": {
                runAfter: { "Filter_|_Newest_Row": ["Succeeded"] },
                type: "Compose",
                inputs: "@first(body('Filter_|_Newest_Row'))",
              },
              "Append_to_array_variable_|_Selected": {
                runAfter: { "Compose_|_Selected_For_Client": ["Succeeded"] },
                type: "AppendToArrayVariable",
                inputs: {
                  name: "varSelected",
                  value: "@outputs('Compose_|_Selected_For_Client')",
                },
              },
            },
          },

          // The run's output IS the dry run: one row per client, the invoice
          // chosen, and the per-channel verdict — the shape #98 asks to diff
          // against the comms tool's recipient list for the same day.
          "Compose_|_Selected_Count": {
            runAfter: { "Apply_to_each_|_Client": ["Succeeded"] },
            type: "Compose",
            inputs: "@length(variables('varSelected'))",
          },
          // ---- #101: the volume tripwire, before anything is produced ----
          // It sits here, not merely "before any send", because the per-client
          // loop below mints tokens, writes them back and renders PDFs in BOTH
          // modes. Everything that costs something happens after this gate.
          //
          // It also fails CLOSED: if this table is missing or unreadable the
          // List below fails, and because it is upstream of the loop the run
          // ends having produced nothing. A broken tripwire stops the campaign
          // rather than waving it through.
          "List_rows_|_Previous_Run": {
            runAfter: { "Compose_|_Selected_Count": ["Succeeded"] },
            ...dataverse("ListRecords", {
              entityName: RUN_TABLE_SET,
              $select: "riivo_name,riivo_selectedcount,riivo_outcome,createdon",
              $filter: baselineFilter,
              // WDL has no sort, but OData does, and one row is all we read.
              $orderby: "createdon desc",
              $top: 1,
            }),
          },
          "Compose_|_Has_Previous_Run": {
            runAfter: { "List_rows_|_Previous_Run": ["Succeeded"] },
            type: "Compose",
            inputs:
              "@greater(length(outputs('List_rows_|_Previous_Run')?['body/value']), 0)",
          },
          // No branch, deliberately: first() of an empty list is null and
          // WDL's ?[] is null-safe, so this reads 0 on its own.
          "Compose_|_Previous_Count": {
            runAfter: { "Compose_|_Has_Previous_Run": ["Succeeded"] },
            type: "Compose",
            inputs:
              "@coalesce(first(outputs('List_rows_|_Previous_Run')?['body/value'])?['riivo_selectedcount'], 0)",
          },
          "Compose_|_Volume_Threshold_Percent": {
            runAfter: { "Compose_|_Previous_Count": ["Succeeded"] },
            type: "Compose",
            inputs: `@int(coalesce(parameters('${VOLUME_THRESHOLD_PARAM}'), '${DEFAULT_VOLUME_THRESHOLD_PERCENT}'))`,
          },

          // Absolute movement, as a percentage of the baseline.
          //
          // WDL has no abs(): the documented math set is add, div, max, min,
          // mod, mul, pow, rand, range, sub. max(a-b, b-a) is the absolute
          // difference, and it reads the same in both directions, which is
          // what "moved by more than" asks for.
          //
          // The divisor is max(previous, 1), not previous, and the guard is not
          // an if(): if() takes its arguments as values, so both arms are
          // evaluated and a "guarded" div() would still divide by zero. The
          // verdict above is what actually excludes a zero baseline; this only
          // has to avoid throwing on the way there.
          //
          // Integer division truncates, so the comparison is coarse by a
          // fraction of a percent — in the direction of proceeding. Accepted:
          // a threshold measured in tens of percent has no use for the
          // difference between 40.9 and 41.
          "Compose_|_Volume_Change_Percent": {
            runAfter: { "Compose_|_Volume_Threshold_Percent": ["Succeeded"] },
            type: "Compose",
            inputs: `@div(mul(max(sub(${selectedCount}, ${previousCount}), sub(${previousCount}, ${selectedCount})), 100), max(${previousCount}, 1))`,
          },
          "Compose_|_Tripwire_Verdict": {
            runAfter: { "Compose_|_Volume_Change_Percent": ["Succeeded"] },
            type: "Compose",
            inputs: `@${verdictExpression}`,
          },
          "Compose_|_Tripwire_Reason": {
            runAfter: { "Compose_|_Tripwire_Verdict": ["Succeeded"] },
            type: "Compose",
            inputs: `@${reasonExpression}`,
          },
          "Compose_|_Run_Name": {
            runAfter: { "Compose_|_Tripwire_Reason": ["Succeeded"] },
            type: "Compose",
            inputs: "@concat('Bad Debt Recovery Run ', utcNow())",
          },

          // Written BEFORE the verdict is acted on, and for every outcome:
          // parked, live or rehearsal. Two reasons it is not deferred to the
          // end of a successful run. The next run's baseline must not depend on
          // this one finishing — a run that dies mid-loop has still selected
          // what it selected. And a parked run is exactly the run whose count a
          // human needs to see.
          "Create_|_Run_Record": {
            runAfter: { "Compose_|_Run_Name": ["Succeeded"] },
            ...dataverse("CreateRecord", {
              entityName: RUN_TABLE_SET,
              "item/riivo_name": "@outputs('Compose_|_Run_Name')",
              "item/riivo_selectedcount": `@${selectedCount}`,
              "item/riivo_previouscount": `@${previousCount}`,
              "item/riivo_changepercent": `@${changePercent}`,
              "item/riivo_thresholdpercent": `@${thresholdPercent}`,
              "item/riivo_outcome": `@${nestedIf(
                [
                  [
                    `equals(${verdict}, '${VERDICT.CANARY}')`,
                    `'${RUN_OUTCOME.CANARY}'`,
                  ],
                  [
                    `equals(${verdict}, '${VERDICT.PROCEED}')`,
                    `'${RUN_OUTCOME.PROCEEDED}'`,
                  ],
                ],
                `'${RUN_OUTCOME.ABORTED}'`,
              )}`,
              // Empty on a canary run: nothing was aborted, and a column named
              // abortreason carrying "this run was restricted" would be a
              // small lie in a table people will read a year from now.
              "item/riivo_abortreason": "@outputs('Compose_|_Tripwire_Reason')",
              "item/riivo_canarycount": "@length(outputs('Compose_|_Canary_Ids'))",
              "item/riivo_testmode": "@outputs('Compose_|_TestMode')",
            }),
          },

          "Condition_|_Tripwire_Tripped": {
            runAfter: { "Create_|_Run_Record": ["Succeeded"] },
            type: "If",
            // Two verdicts run the loop, so this is no longer "not proceed".
            // Written as an explicit pair rather than as a negation of a list
            // because getting it wrong in the permissive direction is a run
            // that sends when it should have parked.
            expression: {
              and: [
                { not: { equals: [`@${verdict}`, VERDICT.PROCEED] } },
                { not: { equals: [`@${verdict}`, VERDICT.CANARY] } },
              ],
            },
            actions: {
              // The house alert, in the shape 218 of this org's flows use it:
              // the child owns the recipient (riivo_varFlowErrorTeamMail), the
              // sender and the run link. `text` and `text_1` are free text it
              // renders verbatim, so the counts travel in the body and the
              // reason reaches the subject line.
              "Run_Child_|_Volume_Alert": {
                runAfter: {},
                type: "Workflow",
                inputs: {
                  host: { workflowReferenceName: ALERT_CHILD_FLOW_ID },
                  body: {
                    text: `@{parameters('${ENVIRONMENT_ADDRESS_PARAM}')} - THE BAD DEBT RECOVERY RUN WAS PARKED AND SENT NOTHING. It @{outputs('Compose_|_Tripwire_Reason')}. No token was minted, no PDF rendered, no touch recorded: no client was contacted or altered, so the run can simply be re-run once someone has established why the population moved. If the new volume is real, set riivo_outcome to '${RUN_OUTCOME.ACCEPTED}' on @{outputs('Compose_|_Run_Name')} and the next run will compare against it. Test mode: @{outputs('Compose_|_TestMode')}.`,
                    text_1: `@{workflow().tags.flowDisplayName} - parked by the volume tripwire`,
                    text_2: "@workflow().tags.environmentName",
                    text_3: "@workflow().name",
                    text_4: "@workflow().run.name",
                  },
                },
              },

              // Any status: an alert that could not be delivered must not keep
              // a parked run alive. The park is the guarantee; the email is a
              // courtesy, and a failed run is itself visible in run history.
              "Terminate_|_Parked": {
                runAfter: {
                  "Run_Child_|_Volume_Alert": [
                    "Succeeded",
                    "Failed",
                    "Skipped",
                    "TimedOut",
                  ],
                },
                type: "Terminate",
                inputs: {
                  // Failed, not Succeeded: a parked run is an event someone
                  // must look at, and Failed is what makes it red in run
                  // history and picked up by the platform's own failure
                  // notifications — a second path to a human if the email fails.
                  runStatus: "Failed",
                  runError: {
                    code: "BadDebtVolumeTripwire",
                    message: `@concat('Run parked: it ', outputs('Compose_|_Tripwire_Reason'), '. Nothing was sent.')`,
                  },
                },
              },
            },
            else: { actions: {} },
          },

          // ---- #102: a restricted run says so, every single time ----
          // Not a park: this branch alerts and then carries straight on into
          // the loop. The thing being guarded against is not setting the
          // canary list, which is deliberate and safe — it is LEAVING it set,
          // which turns a campaign into a private conversation with three
          // people and shows up nowhere a human looks. Twice a week is exactly
          // as annoying as it should be.
          "Condition_|_Canary_Run": {
            runAfter: { "Condition_|_Tripwire_Tripped": ["Succeeded"] },
            type: "If",
            expression: {
              and: [{ equals: [`@${verdict}`, VERDICT.CANARY] }],
            },
            actions: {
              // The house child again. Its subject is hardcoded to
              // "Flow Failure: {text_1}", which this run is not — hence the
              // parenthetical, which is the honest fix available without
              // editing a child 218 other flows depend on.
              "Run_Child_|_Canary_Alert": {
                runAfter: {},
                type: "Workflow",
                inputs: {
                  host: { workflowReferenceName: ALERT_CHILD_FLOW_ID },
                  body: {
                    text: `@{parameters('${ENVIRONMENT_ADDRESS_PARAM}')} - THIS RUN WAS RESTRICTED. ${CANARY_VARIABLE} names @{length(outputs('Compose_|_Canary_Ids'))} client(s), so the run selected @{outputs('Compose_|_Selected_Count')} of them and said nothing to anybody else - the volume tripwire was skipped, and this run is recorded as '${RUN_OUTCOME.CANARY}' so it cannot become the next run's baseline. That is correct while a canary is in progress. WHEN THE CANARY IS DONE, CLEAR ${CANARY_VARIABLE}: until it is empty the bad-debt campaign is only speaking to those clients. Run record: @{outputs('Compose_|_Run_Name')}. Test mode: @{outputs('Compose_|_TestMode')}.`,
                    text_1: `@{workflow().tags.flowDisplayName} - RESTRICTED to a canary list of @{length(outputs('Compose_|_Canary_Ids'))} client(s), not a failure`,
                    text_2: "@workflow().tags.environmentName",
                    text_3: "@workflow().name",
                    text_4: "@workflow().run.name",
                  },
                },
              },
              // Any status, so an undeliverable notice cannot fail the branch
              // and with it a canary run that is otherwise fine. The status
              // reaches the report, which is where someone would look to ask
              // why no notice arrived.
              "Compose_|_Canary_Alert_Status": {
                runAfter: {
                  "Run_Child_|_Canary_Alert": [
                    "Succeeded",
                    "Failed",
                    "Skipped",
                    "TimedOut",
                  ],
                },
                type: "Compose",
                inputs:
                  "@coalesce(outputs('Run_Child_|_Canary_Alert')?['statusCode'], 0)",
              },
            },
            else: { actions: {} },
          },

          "Initialize_variable_|_Touches": {
            // Everything below is reached only by a run the tripwire cleared:
            // Terminate ends the run where it stands, so the loop is never
            // entered on a park. Nothing had to move into a branch for that.
            runAfter: { "Condition_|_Canary_Run": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: { variables: [{ name: "varTouches", type: "array", value: [] }] },
          },
          "Initialize_variable_|_Held": {
            runAfter: { "Initialize_variable_|_Touches": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: { variables: [{ name: "varHeld", type: "array", value: [] }] },
          },
          // Retry flags for the two Until loops. Power Automate only allows a
          // variable to be initialised at the top level, so they live here and
          // are reset per client inside the loop.
          "Initialize_variable_|_Mint_Done": {
            runAfter: { "Initialize_variable_|_Held": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: {
              variables: [{ name: "varMintDone", type: "boolean", value: true }],
            },
          },
          "Initialize_variable_|_Pdf_Done": {
            runAfter: { "Initialize_variable_|_Mint_Done": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: {
              variables: [{ name: "varPdfDone", type: "boolean", value: true }],
            },
          },
          // #103's two Meta calls, each its own Until and therefore its own
          // flag. They live here for the same platform reason as the other
          // two: Power Automate initialises variables at the top level only.
          "Initialize_variable_|_Wa_Upload_Done": {
            runAfter: { "Initialize_variable_|_Pdf_Done": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: {
              variables: [
                { name: "varWaUploadDone", type: "boolean", value: true },
              ],
            },
          },
          "Initialize_variable_|_Wa_Send_Done": {
            runAfter: { "Initialize_variable_|_Wa_Upload_Done": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: {
              variables: [
                { name: "varWaSendDone", type: "boolean", value: true },
              ],
            },
          },

          // ---- campaign key -> template, and the touch it records (#99) ----
          "Apply_to_each_|_Selected": {
            foreach: "@variables('varSelected')",
            runAfter: { "Initialize_variable_|_Wa_Send_Done": ["Succeeded"] },
            type: "Foreach",
            runtimeConfiguration: capped,
            actions: {
              // Relationship is a property of the CLIENT, not of the invoice
              // being chased: "have they ever paid us". Asked as a top-1
              // existence query rather than a count, so a client with 400 paid
              // invoices costs the same as one with a single paid invoice.
              "List_rows_|_Client_Paid_History": {
                runAfter: {},
                ...dataverse("ListRecords", {
                  entityName: "new_invoiceses",
                  $select: "new_invoicesid",
                  $filter: `@concat('_ttt_customer_value eq ', ${selected(
                    "clientId",
                  )}, ' and statuscode eq ${PAID_STATUSCODE}')`,
                  $top: 1,
                }),
              },
              "Compose_|_Relationship": {
                runAfter: { "List_rows_|_Client_Paid_History": ["Succeeded"] },
                type: "Compose",
                inputs: `@if(greater(length(outputs('List_rows_|_Client_Paid_History')?['body/value']), 0), '${RELATIONSHIPS[0]}', '${RELATIONSHIPS[1]}')`,
              },

              // Age is measured from the invoice's createdon, the same basis
              // the proven cadence flow c430ace5 uses for its step ladder, and
              // recomputed each run. riivo_baddebt.riivo_invoiceage is NOT
              // used: it is stamped when the row is created and does not age.
              "Compose_|_Invoice_Age_Days": {
                runAfter: { "Compose_|_Relationship": ["Succeeded"] },
                type: "Compose",
                inputs: `@div(sub(ticks(utcNow()), ticks(${selected(
                  "invoiceCreatedOn",
                )})), 864000000000)`,
              },
              "Compose_|_Age_Band": {
                runAfter: { "Compose_|_Invoice_Age_Days": ["Succeeded"] },
                type: "Compose",
                inputs: `@${ageBandExpression("outputs('Compose_|_Invoice_Age_Days')")}`,
              },

              // The touch this run would be. It is read from
              // riivo_campaignsendcount and, when a send succeeds, written
              // back as the new count - one value, both halves.
              "Compose_|_Touch_Number": {
                runAfter: { "Compose_|_Age_Band": ["Succeeded"] },
                type: "Compose",
                inputs: `@add(coalesce(${selected("sendCount")}, 0), 1)`,
              },
              "Compose_|_Touch_Day": {
                runAfter: { "Compose_|_Touch_Number": ["Succeeded"] },
                type: "Compose",
                inputs: `@${touchDayExpression("outputs('Compose_|_Touch_Number')")}`,
              },

              // Past touch 4 the ladder is spent: D12 hands over to the general
              // template. It must never wrap to touch 1 - a fresh "opening"
              // message after a final notice is the failure this guards.
              "Compose_|_Template_Name": {
                runAfter: { "Compose_|_Touch_Day": ["Succeeded"] },
                type: "Compose",
                inputs: `@if(greater(outputs('Compose_|_Touch_Number'), ${TOUCH_DAYS.length}), parameters('${ONGOING_TEMPLATE_PARAM}'), if(empty(outputs('Compose_|_Age_Band')), '', concat('bad_debt_wa_', outputs('Compose_|_Age_Band'), '_', outputs('Compose_|_Relationship'), '_day', outputs('Compose_|_Touch_Day'))))`,
              },

              // Asserted, not assumed: a ladder name must be one of the 24
              // approved in Meta, and the D12 name must at least be configured.
              "Compose_|_Template_Approved": {
                runAfter: { "Compose_|_Template_Name": ["Succeeded"] },
                type: "Compose",
                inputs: `@if(greater(outputs('Compose_|_Touch_Number'), ${TOUCH_DAYS.length}), not(empty(outputs('Compose_|_Template_Name'))), contains(outputs('Compose_|_Approved_Templates'), outputs('Compose_|_Template_Name')))`,
              },
              "Compose_|_Hold_Reason": {
                runAfter: { "Compose_|_Template_Approved": ["Succeeded"] },
                type: "Compose",
                inputs: `@if(greater(outputs('Compose_|_Touch_Number'), ${TOUCH_DAYS.length}), 'past touch ${TOUCH_DAYS.length} (D12) but ${ONGOING_TEMPLATE_VARIABLE} is blank', if(less(outputs('Compose_|_Invoice_Age_Days'), ${MIN_IN_SCOPE_DAYS}), 'invoice younger than ${MIN_IN_SCOPE_DAYS} days - outside the In-scope window', if(empty(outputs('Compose_|_Age_Band')), 'invoice older than three years - prescribed, outside the In-scope window', concat('no approved Meta template named ', outputs('Compose_|_Template_Name')))))`,
              },

              "Condition_|_Template_Approved": {
                runAfter: { "Compose_|_Hold_Reason": ["Succeeded"] },
                type: "If",
                expression: {
                  and: [
                    { equals: ["@outputs('Compose_|_Template_Approved')", true] },
                  ],
                },
                actions: {
                  // ---- #100: produce both inputs, or say nothing at all ----
                  "Scope_|_Prepare_Documents": {
                    runAfter: {},
                    type: "Scope",
                    actions: {
                      "Compose_|_Link_Enabled": {
                        runAfter: {},
                        type: "Compose",
                        inputs: `@equals(coalesce(parameters('${LINK_ENABLED_PARAM}'), true), true)`,
                      },
                      "Compose_|_Existing_Token": {
                        runAfter: { "Compose_|_Link_Enabled": ["Succeeded"] },
                        type: "Compose",
                        inputs: `@coalesce(${selected("paymentToken")}, '')`,
                      },

                      // Idempotent by SKIPPING, not by comparing: an invoice
                      // that already has a token never reaches the endpoint. A
                      // retried run therefore costs nothing, and cannot
                      // replace a token a client is already holding a link to.
                      "Condition_|_Mint_Needed": {
                        runAfter: { "Compose_|_Existing_Token": ["Succeeded"] },
                        type: "If",
                        expression: {
                          and: [
                            {
                              equals: [
                                "@outputs('Compose_|_Link_Enabled')",
                                true,
                              ],
                            },
                            { equals: ["@outputs('Compose_|_Existing_Token')", ""] },
                          ],
                        },
                        actions: untilNotThrottled({
                          slug: "Mint",
                          variable: "varMintDone",
                          call: "HTTP_|_Mint_Token",
                          runAfter: {},
                          callAction: {
                            type: "Http",
                            inputs: {
                              method: "POST",
                              uri: `@{parameters('${BASE_URL_PARAM}')}/mint-token`,
                              headers: {
                                "Content-Type": "application/json",
                                "x-functions-key": `@parameters('${FUNCTION_KEY_PARAM}')`,
                              },
                              body: { invoiceId: `@{${selected("invoiceId")}}` },
                              retryPolicy: { type: "none" },
                            },
                          },
                        }),
                        else: { actions: {} },
                      },

                      "Compose_|_Payment_Token": {
                        runAfter: { "Condition_|_Mint_Needed": ["Succeeded"] },
                        type: "Compose",
                        inputs:
                          "@if(not(empty(outputs('Compose_|_Existing_Token'))), outputs('Compose_|_Existing_Token'), coalesce(body('HTTP_|_Mint_Token')?['token'], ''))",
                      },

                      // The write-back c430ace5 never had: it mints inline and
                      // drops the token, so it re-mints on every run. Writing
                      // the token is what makes the skip above true next time.
                      // The column is not new ground — 9f8601a5 already owns
                      // this exact patch from the on-create path.
                      "Condition_|_Token_Minted": {
                        runAfter: { "Compose_|_Payment_Token": ["Succeeded"] },
                        type: "If",
                        expression: {
                          and: [
                            { equals: ["@outputs('Compose_|_Existing_Token')", ""] },
                            {
                              not: {
                                equals: [
                                  "@outputs('Compose_|_Payment_Token')",
                                  "",
                                ],
                              },
                            },
                          ],
                        },
                        actions: {
                          "Update_|_Invoice_Token": {
                            runAfter: {},
                            ...dataverse("UpdateRecord", {
                              entityName: "new_invoiceses",
                              recordId: selectedValue("invoiceId"),
                              "item/riivo_paymenttoken":
                                "@outputs('Compose_|_Payment_Token')",
                              // Monotonic, like the touch bookkeeping: a date
                              // already told to a client is never moved.
                              "item/riivo_paymentlinksenton": `@if(empty(coalesce(${selected(
                                "paymentLinkSentOn",
                              )}, '')), utcNow(), ${selected("paymentLinkSentOn")})`,
                            }),
                          },
                        },
                        else: { actions: {} },
                      },

                      // ONE of the two swappable points. Both forms are
                      // published here and read nowhere else: the Meta button
                      // takes the BARE token — Meta rebuilds the URL from the
                      // approved template, and a full URL silently breaks the
                      // button — while email needs the whole link.
                      "Compose_|_Payment_Link": {
                        runAfter: { "Condition_|_Token_Minted": ["Succeeded"] },
                        type: "Compose",
                        inputs: {
                          token: "@outputs('Compose_|_Payment_Token')",
                          url: `@if(empty(outputs('Compose_|_Payment_Token')), '', concat(parameters('${BASE_URL_PARAM}'), '/p/', outputs('Compose_|_Payment_Token')))`,
                        },
                      },

                      ...untilNotThrottled({
                        slug: "Pdf",
                        variable: "varPdfDone",
                        call: "Run_Child_|_Generate_PDF",
                        runAfter: { "Compose_|_Payment_Link": ["Succeeded"] },
                        // No retryPolicy override here, unlike the mint call:
                        // the child's OWN http action already carries the
                        // default policy against `riivo_InvoiceGen2_Endpoint`,
                        // so function-side throttling is absorbed a layer down
                        // where the Retry-After header actually arrives. What
                        // a child flow returns to us is its Response, which
                        // carries no such header to honour.
                        callAction: {
                          type: "Workflow",
                          inputs: {
                            host: { workflowReferenceName: PDF_CHILD_FLOW_ID },
                            body: { invoiceId: selectedValue("invoiceId") },
                          },
                        },
                      }),

                      // THE OTHER swappable point. When the document source
                      // becomes a Statement Issue GUID, the child called and
                      // the id passed to it change HERE; nothing downstream
                      // ever learns that an invoice was involved.
                      "Compose_|_Document": {
                        runAfter: { "Until_|_Pdf": ["Succeeded"] },
                        type: "Compose",
                        inputs: {
                          kind: "invoice",
                          sourceId: selectedValue("invoiceId"),
                          fileName:
                            "@coalesce(body('Run_Child_|_Generate_PDF')?['fileName'], '')",
                          base64:
                            "@coalesce(body('Run_Child_|_Generate_PDF')?['pdfBase64'], '')",
                        },
                      },
                    },
                  },

                  // The scope's failure is HANDLED here, which is what keeps
                  // one client's unrenderable invoice from ending the run for
                  // everyone behind them. @result() reports the scope's
                  // top-level actions, so a failure nested inside one of the
                  // conditions still surfaces as that condition failing.
                  "Filter_|_Prepare_Failures": {
                    runAfter: {
                      "Scope_|_Prepare_Documents": [
                        "Succeeded",
                        "Failed",
                        "Skipped",
                        "TimedOut",
                      ],
                    },
                    type: "Query",
                    inputs: {
                      from: "@result('Scope_|_Prepare_Documents')",
                      where: "@not(equals(item()['status'], 'Succeeded'))",
                    },
                  },
                  "Select_|_Prepare_Failure_Names": {
                    runAfter: { "Filter_|_Prepare_Failures": ["Succeeded"] },
                    type: "Select",
                    inputs: {
                      from: "@body('Filter_|_Prepare_Failures')",
                      select: "@item()['name']",
                    },
                  },

                  // Not "did the scope succeed" but "do we HAVE both things":
                  // a call that failed and a call that returned nothing useful
                  // must abort the client identically. Every read is
                  // null-safe, because an action that was skipped has no
                  // outputs to read.
                  "Compose_|_Prepare_Ok": {
                    runAfter: { "Select_|_Prepare_Failure_Names": ["Succeeded"] },
                    type: "Compose",
                    inputs:
                      "@and(equals(length(body('Filter_|_Prepare_Failures')), 0), not(empty(coalesce(outputs('Compose_|_Payment_Token'), ''))), not(empty(coalesce(outputs('Compose_|_Document')?['base64'], ''))))",
                  },
                  "Compose_|_Prepare_Hold_Reason": {
                    runAfter: { "Compose_|_Prepare_Ok": ["Succeeded"] },
                    type: "Compose",
                    inputs: `@if(not(equals(coalesce(outputs('Compose_|_Link_Enabled'), false), true)), 'payment links are switched off (${PAYMENT_LINK_ENABLED_VARIABLE}), and every approved template carries a Pay-now button', if(empty(coalesce(outputs('Compose_|_Payment_Token'), '')), concat('no payment token: mint-token answered ', string(coalesce(outputs('Compose_|_Mint_Status'), 'nothing'))), if(empty(coalesce(outputs('Compose_|_Document')?['base64'], '')), concat('no invoice PDF: the generate-PDF child answered ', string(coalesce(outputs('Compose_|_Pdf_Status'), 'nothing'))), concat('preparation failed at ', join(body('Select_|_Prepare_Failure_Names'), ', ')))))`,
                  },

                  "Condition_|_Prepare_Ok": {
                    runAfter: { "Compose_|_Prepare_Hold_Reason": ["Succeeded"] },
                    type: "If",
                    expression: {
                      and: [{ equals: ["@outputs('Compose_|_Prepare_Ok')", true] }],
                    },
                    actions: {
                      // ---- #102: the email, built and sent ----
                      "Compose_|_Amount": {
                        runAfter: {},
                        type: "Compose",
                        inputs: `@formatNumber(${selected("outstanding")}, 'N2')`,
                      },
                      "Compose_|_Email_Subject": {
                        runAfter: { "Compose_|_Amount": ["Succeeded"] },
                        type: "Compose",
                        inputs: `@${ladderExpression(
                          "subject",
                          "outputs('Compose_|_Touch_Number')",
                          selected("invoiceNumber"),
                          "outputs('Compose_|_Amount')",
                        )}`,
                      },
                      // string(createArray(...)) rather than a hand-built
                      // JSON string: the child takes these as JSON text, and
                      // letting WDL serialise it is what makes an apostrophe
                      // in the copy a non-event instead of a malformed
                      // payload discovered in production.
                      "Compose_|_Email_Paragraphs": {
                        runAfter: { "Compose_|_Email_Subject": ["Succeeded"] },
                        type: "Compose",
                        inputs: `@string(createArray(${ladderExpression(
                          "paragraph",
                          "outputs('Compose_|_Touch_Number')",
                          selected("invoiceNumber"),
                          "outputs('Compose_|_Amount')",
                        )}, ${literal(EMAIL_CLOSING_PARAGRAPH)}))`,
                      },
                      // Same reasoning, and it matters more here: c430ace5
                      // concatenates the filename straight into a JSON
                      // string, so a quote or a backslash in a generated
                      // invoice name would produce a body the child cannot
                      // parse. Composing the object and serialising it cannot
                      // have that bug.
                      "Compose_|_Email_Attachment": {
                        runAfter: { "Compose_|_Email_Paragraphs": ["Succeeded"] },
                        type: "Compose",
                        inputs: {
                          name: "@outputs('Compose_|_Document')?['fileName']",
                          contentBytes: "@outputs('Compose_|_Document')?['base64']",
                          contentType: "application/pdf",
                        },
                      },

                      // Test mode sends nothing at all, and creates no email
                      // row — a departure from c430ace5, which redirects to
                      // riivo_TestRecipient instead. Its population is a
                      // handful of invoices; ours is the whole bad-debt book,
                      // and a redirected rehearsal would mail one address
                      // several hundred times. The dry-run report already
                      // says who would get what; seeing the RENDERED message
                      // is what the canary list is for, and with
                      // riivo_SendEmail off the first canary run leaves
                      // inspectable drafts rather than sent mail.
                      "Condition_|_Send_Email": {
                        runAfter: { "Compose_|_Email_Attachment": ["Succeeded"] },
                        type: "If",
                        expression: {
                          and: [
                            { equals: ["@outputs('Compose_|_TestMode')", false] },
                            {
                              equals: [
                                `@coalesce(${selected("emailAllowed")}, false)`,
                                true,
                              ],
                            },
                          ],
                        },
                        actions: {
                          // The house pattern, in one call: the child creates
                          // the `email` row, writes the activitymimeattachment
                          // and then performs the bound SendEmail. The Outlook
                          // connector appears nowhere in this path — sending
                          // as a Dataverse activity is what keeps the message
                          // on the client's timeline and in TTT's email stats.
                          "Run_Child_|_Send_Email": {
                            runAfter: {},
                            type: "Workflow",
                            inputs: {
                              host: {
                                workflowReferenceName: EMAIL_CHILD_FLOW_ID,
                              },
                              body: {
                                // System, not Consultant: the From party is
                                // the service queue, and the child's
                                // CC-the-owning-consultant behaviour is off
                                // entirely — nobody is CC'd on a few hundred
                                // dunning emails twice a week.
                                variant: "System",
                                // Transactional: a demand for payment on a
                                // named invoice, not marketing. Our own
                                // selection has already applied donotemail
                                // AND donotbulkemail, so this loses no
                                // suppression the Marketing category would
                                // have added.
                                category: "Transactional",
                                audience: "Client",
                                toRecipientEntitySet: "contacts",
                                toRecipientId: selectedValue("clientId"),
                                senderUserId: `@parameters('${SENDER_USER_PARAM}')`,
                                subject: "@outputs('Compose_|_Email_Subject')",
                                greetingName: selectedValue("firstName"),
                                paragraphsJson:
                                  "@outputs('Compose_|_Email_Paragraphs')",
                                buttonUrl:
                                  "@outputs('Compose_|_Payment_Link')?['url']",
                                // The label is blanked with the URL: the child
                                // renders the button only when it has both, so
                                // a missing link cannot produce a button that
                                // goes nowhere. (Prepare_Ok already refuses to
                                // get here without a token; this is the second
                                // lock on the same door.)
                                buttonLabel:
                                  "@if(empty(coalesce(outputs('Compose_|_Payment_Link')?['url'], '')), '', 'Pay now')",
                                attachmentsJson:
                                  "@string(createArray(outputs('Compose_|_Email_Attachment')))",
                                // Regarding the invoice: that is what puts the
                                // message on the timeline, and what makes the
                                // Statement swap a change to Compose_|_Document
                                // and these two lines alone.
                                regardingEntitySet: "new_invoiceses",
                                regardingId: selectedValue("invoiceId"),
                              },
                            },
                          },
                        },
                        else: { actions: {} },
                      },

                      // Any status. A child that failed for this client — a
                      // bad sender id, a Dataverse hiccup — must not end the
                      // run for the clients behind them, and reading the
                      // result on Failed is what handles that failure. Every
                      // read is null-safe because a skipped or failed call
                      // has no body.
                      "Compose_|_Email_Result": {
                        runAfter: {
                          "Condition_|_Send_Email": [
                            "Succeeded",
                            "Failed",
                            "Skipped",
                            "TimedOut",
                          ],
                        },
                        type: "Compose",
                        inputs: {
                          attempted: `@and(equals(outputs('Compose_|_TestMode'), false), equals(coalesce(${selected("emailAllowed")}, false), true))`,
                          // The CHILD's answer, not ours. It re-reads the
                          // contact at send time and refuses on donotemail or
                          // a recorded bounce, and it reports false when the
                          // org switch left the mail as a draft. So "sent"
                          // here means the mail system took it — which is
                          // exactly the condition the touch bookkeeping wants.
                          sent: "@equals(coalesce(body('Run_Child_|_Send_Email')?['sent'], false), true)",
                          emailId:
                            "@coalesce(body('Run_Child_|_Send_Email')?['emailId'], '')",
                          note: `@${nestedIf(
                            [
                              [
                                "outputs('Compose_|_TestMode')",
                                "'test mode: no email was created and none was sent'",
                              ],
                              [
                                `not(equals(coalesce(${selected("emailAllowed")}, false), true))`,
                                "'email suppressed for this client at selection: donotemail, donotbulkemail or no address'",
                              ],
                              [
                                "equals(coalesce(body('Run_Child_|_Send_Email')?['sent'], false), true)",
                                "''",
                              ],
                              [
                                "equals(coalesce(body('Run_Child_|_Send_Email')?['skipped'], false), true)",
                                "coalesce(body('Run_Child_|_Send_Email')?['skipReason'], 'the branded-email child skipped the send')",
                              ],
                              [
                                "empty(coalesce(body('Run_Child_|_Send_Email')?['emailId'], ''))",
                                "'the branded-email child did not answer - see this run in the run history'",
                              ],
                            ],
                            `'the email was created but not sent, because ${SEND_EMAIL_VARIABLE} is off in this environment'`,
                          )}`,
                        },
                      },

                      // ---- #103: the WhatsApp channel ----
                      // Sequential after the email rather than beside it: two
                      // concurrent sends to the same client would interleave
                      // their failures in the run history, and nothing here is
                      // slow enough to be worth that.
                      //
                      // Every value Meta receives is sanitised first, because a
                      // parameter carrying a newline, a tab or four consecutive
                      // spaces is refused with a 400 — a silent client, not an
                      // obviously broken message.
                      "Compose_|_Wa_To": {
                        runAfter: { "Compose_|_Email_Result": ["Succeeded"] },
                        type: "Compose",
                        inputs: `@trim(coalesce(${selected("mobile")}, ''))`,
                      },
                      "Compose_|_Wa_Name": {
                        runAfter: { "Compose_|_Wa_To": ["Succeeded"] },
                        type: "Compose",
                        inputs: `@${metaParameter(
                          `coalesce(${selected("firstName")}, 'there')`,
                        )}`,
                      },
                      // Invoice numbers in this org carry trailing spaces
                      // ("luc duval - WATEST83695332 "), which trim() removes.
                      // Only the D12 template interpolates one, but it is
                      // cleaned unconditionally so the two paths cannot differ.
                      "Compose_|_Wa_Invoice": {
                        runAfter: { "Compose_|_Wa_Name": ["Succeeded"] },
                        type: "Compose",
                        inputs: `@${metaParameter(
                          `coalesce(${selected("invoiceNumber")}, '')`,
                        )}`,
                      },
                      // The templates render "Amount due: {{2}}" with no
                      // currency of their own, so the "R" travels in the
                      // parameter — the same shape c430ace5 sends.
                      "Compose_|_Wa_Amount": {
                        runAfter: { "Compose_|_Wa_Invoice": ["Succeeded"] },
                        type: "Compose",
                        inputs: `@${metaParameter(
                          "concat('R ', outputs('Compose_|_Amount'))",
                        )}`,
                      },

                      // The filename travels inside a Content-Disposition
                      // header, where a quote or a backslash ends the field
                      // early — the multipart equivalent of the hand-built
                      // JSON #102 refused to write. Both are removed by code
                      // point rather than as literals, so nothing in this file
                      // or the deployed JSON depends on a character a diff
                      // cannot show.
                      "Compose_|_Wa_File_Clean": {
                        runAfter: { "Compose_|_Wa_Amount": ["Succeeded"] },
                        type: "Compose",
                        inputs: `@${fileNameExpression(
                          "coalesce(outputs('Compose_|_Document')?['fileName'], '')",
                        )}`,
                      },
                      "Compose_|_Wa_File_Name": {
                        runAfter: { "Compose_|_Wa_File_Clean": ["Succeeded"] },
                        type: "Compose",
                        inputs:
                          "@if(empty(outputs('Compose_|_Wa_File_Clean')), 'invoice.pdf', outputs('Compose_|_Wa_File_Clean'))",
                      },

                      // The two shapes, composed separately and chosen
                      // between — WDL cannot build an object inside an
                      // expression, and this is how both reference flows do it.
                      "Compose_|_Wa_Params_Campaign": {
                        runAfter: { "Compose_|_Wa_File_Name": ["Succeeded"] },
                        type: "Compose",
                        inputs: textParameters(CAMPAIGN_BODY_PARAMETERS),
                      },
                      "Compose_|_Wa_Params_Ongoing": {
                        runAfter: {
                          "Compose_|_Wa_Params_Campaign": ["Succeeded"],
                        },
                        type: "Compose",
                        inputs: textParameters(ONGOING_BODY_PARAMETERS),
                      },

                      // Asserted, not assumed — the issue's own instruction.
                      // If sanitisation ever fails to produce a clean value,
                      // this holds the client instead of handing Meta a send
                      // it will refuse, and the report names them.
                      "Compose_|_Wa_Params_Clean": {
                        runAfter: {
                          "Compose_|_Wa_Params_Ongoing": ["Succeeded"],
                        },
                        type: "Compose",
                        inputs: `@and(${metaParameterClean(
                          "outputs('Compose_|_Wa_Name')",
                        )}, ${metaParameterClean(
                          "outputs('Compose_|_Wa_Amount')",
                        )}, if(greater(outputs('Compose_|_Touch_Number'), ${TOUCH_DAYS.length}), ${metaParameterClean(
                          "outputs('Compose_|_Wa_Invoice')",
                        )}, true))`,
                      },

                      "Condition_|_Send_WhatsApp": {
                        runAfter: { "Compose_|_Wa_Params_Clean": ["Succeeded"] },
                        type: "If",
                        expression: {
                          and: [
                            { equals: ["@outputs('Compose_|_TestMode')", false] },
                            {
                              equals: [
                                `@coalesce(${selected("whatsAppAllowed")}, false)`,
                                true,
                              ],
                            },
                            {
                              not: { equals: ["@outputs('Compose_|_Wa_To')", ""] },
                            },
                            {
                              equals: [
                                "@outputs('Compose_|_Wa_Params_Clean')",
                                true,
                              ],
                            },
                          ],
                        },
                        actions: {
                          // The scope exists for the same reason
                          // Scope_|_Prepare_Documents does: its failure is
                          // handled by the actions AFTER it, so one client's
                          // refused send cannot end a sequential loop for the
                          // clients behind them.
                          "Scope_|_Send_WhatsApp": {
                            runAfter: {},
                            type: "Scope",
                            actions: {
                              ...untilNotThrottled({
                                slug: "Wa_Upload",
                                variable: "varWaUploadDone",
                                call: "HTTP_|_Wa_Upload_Media",
                                runAfter: {},
                                callAction: {
                                  type: "Http",
                                  inputs: {
                                    method: "POST",
                                    uri: `@parameters('${META_UPLOAD_PARAM}')`,
                                    headers: {
                                      Authorization: `bearer @{parameters('${META_TOKEN_PARAM}')}`,
                                    },
                                    body: {
                                      "$content-type": "multipart/form-data",
                                      $multipart: [
                                        {
                                          headers: {
                                            "Content-Disposition":
                                              'form-data; name="messaging_product"',
                                          },
                                          body: "whatsapp",
                                        },
                                        {
                                          headers: {
                                            "Content-Disposition":
                                              'form-data; name="type"',
                                          },
                                          body: "document",
                                        },
                                        {
                                          headers: {
                                            "Content-Disposition":
                                              'form-data; name="file"; filename="@{outputs(\'Compose_|_Wa_File_Name\')}"',
                                            "Content-Type": "application/pdf",
                                          },
                                          // NO BRACES. `@base64ToBinary(x)`
                                          // passes the decoded bytes;
                                          // `@{base64ToBinary(x)}` interpolates
                                          // them back into a string, so Meta
                                          // accepts the upload, returns a media
                                          // id, and the client receives a PDF
                                          // whose contents are base64 text.
                                          // That exact pair is still deployed
                                          // in dev as `[TEST] WhatsApp Invoice
                                          // - Buggy vs Fixed PDF Upload`; this
                                          // is the FIXED form, and a test pins
                                          // it because nothing else would
                                          // notice.
                                          body: "@base64ToBinary(outputs('Compose_|_Document')?['base64'])",
                                        },
                                      ],
                                    },
                                    // The Until owns the retries, so the
                                    // platform's own policy must not also
                                    // retry on a schedule of its own.
                                    retryPolicy: { type: "none" },
                                  },
                                },
                              }),

                              // The one Parse_JSON in this path, and it earns
                              // its place by FAILING: `required: ["id"]` means
                              // an upload that answered without a media id
                              // ends the scope here rather than sending a
                              // template whose document header points at
                              // nothing. The send response is read straight off
                              // the HTTP action instead, null-safely, because
                              // there the status code is the verdict.
                              "Parse_JSON_|_Wa_Media": {
                                runAfter: { "Until_|_Wa_Upload": ["Succeeded"] },
                                type: "ParseJson",
                                inputs: {
                                  content: "@body('HTTP_|_Wa_Upload_Media')",
                                  schema: {
                                    type: "object",
                                    properties: { id: { type: "string" } },
                                    required: ["id"],
                                  },
                                },
                              },

                              "Compose_|_Wa_Header": {
                                runAfter: {
                                  "Parse_JSON_|_Wa_Media": ["Succeeded"],
                                },
                                type: "Compose",
                                inputs: {
                                  type: "header",
                                  parameters: [
                                    {
                                      type: "document",
                                      document: {
                                        id: "@{body('Parse_JSON_|_Wa_Media')?['id']}",
                                        filename:
                                          "@{outputs('Compose_|_Wa_File_Name')}",
                                      },
                                    },
                                  ],
                                },
                              },
                              "Compose_|_Wa_Body": {
                                runAfter: { "Compose_|_Wa_Header": ["Succeeded"] },
                                type: "Compose",
                                inputs: {
                                  type: "body",
                                  parameters: `@if(greater(outputs('Compose_|_Touch_Number'), ${TOUCH_DAYS.length}), outputs('Compose_|_Wa_Params_Ongoing'), outputs('Compose_|_Wa_Params_Campaign'))`,
                                },
                              },
                              // THE BARE TOKEN, never the URL. Meta stores the
                              // approved prefix and rebuilds prefix + suffix,
                              // so a full URL produces a link to a link. This
                              // is why #100 published both forms from one
                              // compose: the email takes `url`, and this is the
                              // only reader of `token`.
                              "Compose_|_Wa_Button": {
                                runAfter: { "Compose_|_Wa_Body": ["Succeeded"] },
                                type: "Compose",
                                inputs: {
                                  type: "button",
                                  sub_type: "url",
                                  index: "0",
                                  parameters: [
                                    {
                                      type: "text",
                                      text: "@{outputs('Compose_|_Payment_Link')?['token']}",
                                    },
                                  ],
                                },
                              },
                              // Always all three. c430ace5 drops the button for
                              // its no-button template; every template this
                              // flow can resolve — the 24 campaign ones and the
                              // D12 fallback — carries a document header and a
                              // URL button, read off the WABA on 2026-09-11.
                              "Compose_|_Wa_Components": {
                                runAfter: { "Compose_|_Wa_Button": ["Succeeded"] },
                                type: "Compose",
                                inputs:
                                  "@createArray(outputs('Compose_|_Wa_Header'), outputs('Compose_|_Wa_Body'), outputs('Compose_|_Wa_Button'))",
                              },

                              ...untilNotThrottled({
                                slug: "Wa_Send",
                                variable: "varWaSendDone",
                                call: "HTTP_|_Wa_Send_Template",
                                runAfter: {
                                  "Compose_|_Wa_Components": ["Succeeded"],
                                },
                                callAction: {
                                  type: "Http",
                                  inputs: {
                                    method: "POST",
                                    uri: `@parameters('${META_SEND_PARAM}')`,
                                    headers: {
                                      "Content-Type": "application/json",
                                      Authorization: `bearer @{parameters('${META_TOKEN_PARAM}')}`,
                                    },
                                    body: {
                                      messaging_product: "whatsapp",
                                      recipient_type: "individual",
                                      to: "@{outputs('Compose_|_Wa_To')}",
                                      type: "template",
                                      template: {
                                        // The resolved campaign key itself, not
                                        // a second resolution of it.
                                        name: "@{outputs('Compose_|_Template_Name')}",
                                        language: { code: TEMPLATE_LANGUAGE },
                                        components:
                                          "@outputs('Compose_|_Wa_Components')",
                                      },
                                    },
                                    retryPolicy: { type: "none" },
                                  },
                                },
                              }),
                            },
                          },

                          "Filter_|_Wa_Failures": {
                            runAfter: {
                              "Scope_|_Send_WhatsApp": [
                                "Succeeded",
                                "Failed",
                                "Skipped",
                                "TimedOut",
                              ],
                            },
                            type: "Query",
                            inputs: {
                              from: "@result('Scope_|_Send_WhatsApp')",
                              where: "@not(equals(item()['status'], 'Succeeded'))",
                            },
                          },
                          "Select_|_Wa_Failure_Names": {
                            runAfter: { "Filter_|_Wa_Failures": ["Succeeded"] },
                            type: "Select",
                            inputs: {
                              from: "@body('Filter_|_Wa_Failures')",
                              select: "@item()['name']",
                            },
                          },
                          // `?[0]` rather than first(): a skipped action has no
                          // body at all, and index access stays null-safe where
                          // first() on null does not.
                          "Compose_|_Wa_Message_Id": {
                            runAfter: {
                              "Select_|_Wa_Failure_Names": ["Succeeded"],
                            },
                            type: "Compose",
                            inputs:
                              "@coalesce(outputs('HTTP_|_Wa_Send_Template')?['body']?['messages']?[0]?['id'], '')",
                          },
                          // Meta's own receipt is the verdict, exactly as the
                          // email channel defers to the child's `sent`. A 429
                          // retried to exhaustion, a refused template and a
                          // rejected parameter all read false here and advance
                          // no counter, so the client is simply selected again.
                          "Compose_|_Wa_Sent": {
                            runAfter: { "Compose_|_Wa_Message_Id": ["Succeeded"] },
                            type: "Compose",
                            inputs:
                              "@and(equals(length(body('Filter_|_Wa_Failures')), 0), not(empty(outputs('Compose_|_Wa_Message_Id'))))",
                          },
                          // Ordered so the FIRST thing that went wrong is what
                          // the reason names: an upload that failed makes every
                          // action after it fail too, and "the send was skipped"
                          // would send a reader to the wrong call.
                          "Compose_|_Wa_Failure_Reason": {
                            runAfter: { "Compose_|_Wa_Sent": ["Succeeded"] },
                            type: "Compose",
                            inputs: `@${nestedIf(
                              [
                                ["outputs('Compose_|_Wa_Sent')", "''"],
                                [
                                  "not(equals(coalesce(outputs('Compose_|_Wa_Upload_Status'), 0), 200))",
                                  "concat('the invoice PDF could not be uploaded to Meta: the media endpoint answered ', string(coalesce(outputs('Compose_|_Wa_Upload_Status'), 'nothing')))",
                                ],
                                [
                                  "not(equals(coalesce(outputs('Compose_|_Wa_Send_Status'), 0), 200))",
                                  `concat('Meta refused the template send with ', string(coalesce(outputs('Compose_|_Wa_Send_Status'), 'nothing')), ': ', string(coalesce(outputs('HTTP_|_Wa_Send_Template')?['body']?['error']?['message'], 'no message')), ' (template ', outputs('Compose_|_Template_Name'), ')')`,
                                ],
                                [
                                  "empty(outputs('Compose_|_Wa_Message_Id'))",
                                  "'Meta accepted the send but returned no message id'",
                                ],
                              ],
                              "concat('the WhatsApp send failed at ', join(body('Select_|_Wa_Failure_Names'), ', '))",
                            )}`,
                          },

                          // ONE row per attempt, sent or failed, because the
                          // run report expires with the run history and this is
                          // the only durable place a consultant sees that a
                          // touch was tried at all.
                          "Create_|_Wa_Comm": {
                            runAfter: {
                              "Compose_|_Wa_Failure_Reason": ["Succeeded"],
                            },
                            ...dataverse("CreateRecord", {
                              entityName: "riivo_whatsappcommunicationses",
                              "item/subject": `@concat('Bad debt recovery touch ', string(outputs('Compose_|_Touch_Number')), ' via WhatsApp - ', outputs('Compose_|_Wa_Invoice'))`,
                              "item/activitypointer_activity_parties": [
                                {
                                  participationtypemask: 2,
                                  "partyid@odata.bind": `contacts(@{${selected(
                                    "clientId",
                                  )}})`,
                                },
                              ],
                              "item/description": `@concat('Bad debt recovery touch ', string(outputs('Compose_|_Touch_Number')), ' (template ', outputs('Compose_|_Template_Name'), '), outstanding ', outputs('Compose_|_Wa_Amount'), ' on invoice ', outputs('Compose_|_Wa_Invoice'), '. The invoice PDF was attached as the template document header and a Pay-now button carried the payment token.')`,
                              "item/riivo_messagedirection": WA_DIRECTION_OUTBOUND,
                              "item/riivo_clickatellstatus": `@if(outputs('Compose_|_Wa_Sent'), ${WA_STATUS.SENT}, ${WA_STATUS.FAILED})`,
                              "item/riivo_apimessageid":
                                "@outputs('Compose_|_Wa_Message_Id')",
                              // Meta's errors are not bounded; the column is.
                              "item/riivo_failurereason": `@if(greater(length(outputs('Compose_|_Wa_Failure_Reason')), ${WA_FAILURE_REASON_MAX}), substring(outputs('Compose_|_Wa_Failure_Reason'), 0, ${WA_FAILURE_REASON_MAX}), outputs('Compose_|_Wa_Failure_Reason'))`,
                              "item/riivo_to": "@outputs('Compose_|_Wa_To')",
                              "item/riivo_timestamp": "@utcNow()",
                              "item/regardingobjectid_new_invoices_riivo_whatsappcommunications@odata.bind": `new_invoiceses(@{${selected(
                                "invoiceId",
                              )}})`,
                            }),
                          },

                          "Condition_|_Wa_Notify": {
                            // Any status: a log row that could not be written
                            // must not cost the client behind this one their
                            // turn, and the message has already gone out.
                            runAfter: {
                              "Create_|_Wa_Comm": [
                                "Succeeded",
                                "Failed",
                                "Skipped",
                                "TimedOut",
                              ],
                            },
                            type: "If",
                            expression: {
                              and: [
                                { equals: ["@outputs('Compose_|_Wa_Sent')", true] },
                              ],
                            },
                            actions: {
                              "Run_Child_|_Wa_Notify": {
                                runAfter: {},
                                type: "Workflow",
                                inputs: {
                                  host: {
                                    workflowReferenceName: NOTIFY_CHILD_FLOW_ID,
                                  },
                                  body: {
                                    phone: "@outputs('Compose_|_Wa_To')",
                                    template_name:
                                      "@outputs('Compose_|_Template_Name')",
                                    template_language: TEMPLATE_LANGUAGE,
                                    // The body parameters as sent, so the bot
                                    // renders the same message it is threading
                                    // a reply to.
                                    template_variables: `@string(if(greater(outputs('Compose_|_Touch_Number'), ${TOUCH_DAYS.length}), createArray(outputs('Compose_|_Wa_Name'), outputs('Compose_|_Wa_Invoice'), outputs('Compose_|_Wa_Amount')), createArray(outputs('Compose_|_Wa_Name'), outputs('Compose_|_Wa_Amount'))))`,
                                    template_header_variable: "",
                                    sender_message_id:
                                      "@outputs('Compose_|_Wa_Message_Id')",
                                    sent_at: "@utcNow()",
                                    sender: "power_automate_bad_debt_recovery",
                                  },
                                },
                              },
                            },
                            else: { actions: {} },
                          },
                          // Terminal and always Succeeded, so neither an
                          // undeliverable notice nor a failed log row can fail
                          // the branch — and the status still reaches the
                          // report, which is where someone would ask why the
                          // bot never heard about a message.
                          "Compose_|_Wa_Notify_Status": {
                            runAfter: {
                              "Condition_|_Wa_Notify": [
                                "Succeeded",
                                "Failed",
                                "Skipped",
                                "TimedOut",
                              ],
                            },
                            type: "Compose",
                            inputs:
                              "@coalesce(outputs('Run_Child_|_Wa_Notify')?['statusCode'], 0)",
                          },
                        },
                        else: { actions: {} },
                      },

                      "Compose_|_Wa_Result": {
                        runAfter: {
                          "Condition_|_Send_WhatsApp": [
                            "Succeeded",
                            "Failed",
                            "Skipped",
                            "TimedOut",
                          ],
                        },
                        type: "Compose",
                        inputs: {
                          attempted: `@and(equals(outputs('Compose_|_TestMode'), false), equals(coalesce(${selected("whatsAppAllowed")}, false), true), not(equals(outputs('Compose_|_Wa_To'), '')), equals(outputs('Compose_|_Wa_Params_Clean'), true))`,
                          sent: "@equals(coalesce(outputs('Compose_|_Wa_Sent'), false), true)",
                          messageId:
                            "@coalesce(outputs('Compose_|_Wa_Message_Id'), '')",
                          note: `@${nestedIf(
                            [
                              [
                                "outputs('Compose_|_TestMode')",
                                "'test mode: nothing was uploaded to Meta and no template was sent'",
                              ],
                              [
                                `not(equals(coalesce(${selected("whatsAppAllowed")}, false), true))`,
                                "'WhatsApp suppressed for this client at selection: not opted in via riivo_whatsappoptinout, or no mobile number'",
                              ],
                              [
                                "equals(outputs('Compose_|_Wa_To'), '')",
                                "'no mobile number on the contact at send time'",
                              ],
                              [
                                "not(equals(outputs('Compose_|_Wa_Params_Clean'), true))",
                                "'held: a template parameter still carried a newline, a tab or four consecutive spaces after sanitisation, which Meta refuses'",
                              ],
                              [
                                "equals(coalesce(outputs('Compose_|_Wa_Sent'), false), true)",
                                "''",
                              ],
                            ],
                            "coalesce(outputs('Compose_|_Wa_Failure_Reason'), 'the WhatsApp send did not answer - see this run in the run history')",
                          )}`,
                        },
                      },

                      "Append_to_array_variable_|_Touch": {
                        runAfter: { "Compose_|_Wa_Result": ["Succeeded"] },
                        type: "AppendToArrayVariable",
                        inputs: {
                          name: "varTouches",
                          value: {
                            badDebtId: selectedValue("badDebtId"),
                            clientId: selectedValue("clientId"),
                            invoiceId: selectedValue("invoiceId"),
                            invoiceNumber: selectedValue("invoiceNumber"),
                            outstanding: selectedValue("outstanding"),
                            invoiceCreatedOn: selectedValue("invoiceCreatedOn"),
                            ageDays: "@outputs('Compose_|_Invoice_Age_Days')",
                            ageBand: "@outputs('Compose_|_Age_Band')",
                            relationship: "@outputs('Compose_|_Relationship')",
                            touch: "@outputs('Compose_|_Touch_Number')",
                            templateName: "@outputs('Compose_|_Template_Name')",
                            emailAllowed: selectedValue("emailAllowed"),
                            whatsAppAllowed: selectedValue("whatsAppAllowed"),
                            paymentLink: "@outputs('Compose_|_Payment_Link')?['url']",
                            documentName: "@outputs('Compose_|_Document')?['fileName']",
                            // The LENGTH, never the bytes: a base64 PDF per
                            // client in an array variable would bloat every
                            // run's history and the report with it.
                            documentBytes:
                              "@length(coalesce(outputs('Compose_|_Document')?['base64'], ''))",
                            // What the email channel actually did for this
                            // client, carried on the row rather than counted
                            // at the end: a client the run resolved but did
                            // not reach is a silent client, and the same rule
                            // the held rows follow applies here — never
                            // silent without a reason attached.
                            emailSent: "@outputs('Compose_|_Email_Result')?['sent']",
                            emailNote: "@outputs('Compose_|_Email_Result')?['note']",
                            emailId: "@outputs('Compose_|_Email_Result')?['emailId']",
                            // The same three questions of the other channel.
                            // Both are on the row rather than counted at the
                            // end, because "who did we reach, and how" is
                            // per-client and the counts cannot answer it.
                            whatsAppSent: "@outputs('Compose_|_Wa_Result')?['sent']",
                            whatsAppNote: "@outputs('Compose_|_Wa_Result')?['note']",
                            whatsAppMessageId:
                              "@outputs('Compose_|_Wa_Result')?['messageId']",
                          },
                        },
                      },

                      // THE SEAM, filled in on both sides as of #103.
                      // Bookkeeping records a touch that HAPPENED, so this
                      // composes what each channel actually achieved rather
                      // than what was attempted: a suppressed recipient, a
                      // skipped send, a draft left by the org switch and a
                      // template Meta refused all read as false here and
                      // advance no counter.
                      //
                      // It stays an OR, which is the campaign's rule and not an
                      // accident of the seam: a client reached on either
                      // channel has had their touch, and counting it twice
                      // would spend two rungs of a five-rung ladder on one day.
                      "Compose_|_Send_Outcome": {
                        runAfter: {
                          "Append_to_array_variable_|_Touch": ["Succeeded"],
                        },
                        type: "Compose",
                        inputs: {
                          email: "@outputs('Compose_|_Email_Result')?['sent']",
                          whatsApp: "@outputs('Compose_|_Wa_Result')?['sent']",
                        },
                      },
                      "Compose_|_Touch_Sent": {
                        runAfter: { "Compose_|_Send_Outcome": ["Succeeded"] },
                        type: "Compose",
                        inputs:
                          "@and(not(outputs('Compose_|_TestMode')), or(equals(outputs('Compose_|_Send_Outcome')?['email'], true), equals(outputs('Compose_|_Send_Outcome')?['whatsApp'], true)))",
                      },

                      "Condition_|_Touch_Sent": {
                        runAfter: { "Compose_|_Touch_Sent": ["Succeeded"] },
                        type: "If",
                        expression: {
                          and: [
                            { equals: ["@outputs('Compose_|_Touch_Sent')", true] },
                          ],
                        },
                        actions: {
                          // riivo_campaignfirstsent is stamped once, ever. The
                          // branch is on the field itself rather than on the
                          // count so that a reset counter cannot rewrite a
                          // date that has already been told to a client.
                          "Condition_|_First_Touch": {
                            runAfter: {},
                            type: "If",
                            expression: {
                              and: [
                                {
                                  equals: [
                                    `@empty(coalesce(${selected("firstSent")}, ''))`,
                                    true,
                                  ],
                                },
                              ],
                            },
                            actions: { "Update_|_Touch_First": touchUpdate(true) },
                            else: {
                              actions: {
                                "Update_|_Touch_Repeat": touchUpdate(false),
                              },
                            },
                          },
                        },
                        else: { actions: {} },
                      },
                    },
                    // No bookkeeping patch anywhere down here: an aborted
                    // client's riivo_campaignsendcount and
                    // riivo_campaignlastsent are left exactly as they were, so
                    // the next scheduled run selects them again unchanged.
                    else: {
                      actions: {
                        "Append_to_array_variable_|_Held_Prepare": heldRow(
                          "@outputs('Compose_|_Prepare_Hold_Reason')",
                        ),
                      },
                    },
                  },
                },
                else: {
                  actions: {
                    "Append_to_array_variable_|_Held": heldRow(
                      "@outputs('Compose_|_Hold_Reason')",
                    ),
                  },
                },
              },
            },
          },

          // The run history's second half. Selected/previous/threshold were
          // written before the loop because the baseline must not depend on the
          // loop finishing; resolved and held can only be known after it, so
          // they arrive as a patch and stay null on a run that never got here.
          // Counted from the touch rows rather than tallied in a variable
          // inside the loop: a counter incremented per iteration would be one
          // more piece of cross-iteration state resting on the sequential-loop
          // assumption, and this asks the same question of data that is
          // already there.
          "Filter_|_Emails_Sent": {
            runAfter: { "Apply_to_each_|_Selected": ["Succeeded"] },
            type: "Query",
            inputs: {
              from: "@variables('varTouches')",
              where: "@equals(item()['emailSent'], true)",
            },
          },

          // Counted separately, never summed with the email count: the two
          // channels fail for different reasons, and a run where WhatsApp
          // collapsed while email held up is invisible in a single total.
          "Filter_|_WhatsApps_Sent": {
            runAfter: { "Filter_|_Emails_Sent": ["Succeeded"] },
            type: "Query",
            inputs: {
              from: "@variables('varTouches')",
              where: "@equals(item()['whatsAppSent'], true)",
            },
          },

          "Update_|_Run_Record": {
            runAfter: { "Filter_|_WhatsApps_Sent": ["Succeeded"] },
            ...dataverse("UpdateRecord", {
              entityName: RUN_TABLE_SET,
              recordId: `@outputs('Create_|_Run_Record')?['body/${RUN_TABLE_ID}']`,
              "item/riivo_resolvedcount": "@length(variables('varTouches'))",
              "item/riivo_heldcount": "@length(variables('varHeld'))",
              // Resolved says ready; this says the mail system took it. The
              // gap between the two is the campaign's actual reach, and it is
              // the number this table exists to make readable run over run.
              "item/riivo_emailsentcount": "@length(body('Filter_|_Emails_Sent'))",
              "item/riivo_whatsappsentcount":
                "@length(body('Filter_|_WhatsApps_Sent'))",
            }),
          },

          "Compose_|_Dry_Run_Report": {
            runAfter: { "Update_|_Run_Record": ["Succeeded"] },
            type: "Compose",
            inputs: {
              flow: FLOW_NAME,
              testMode: "@outputs('Compose_|_TestMode')",
              lastSentCutoff: "@outputs('Compose_|_Last_Sent_Cutoff')",
              candidatesBeforeCollapse: "@length(variables('varCandidates'))",
              selectedClients: "@outputs('Compose_|_Selected_Count')",
              // The tripwire's working, on a run it let through: a human
              // reading the report can see how close it came without opening
              // the run history.
              runRecord: "@outputs('Compose_|_Run_Name')",
              previousRunClients: "@outputs('Compose_|_Previous_Count')",
              volumeChangePercent: "@outputs('Compose_|_Volume_Change_Percent')",
              volumeThresholdPercent:
                "@outputs('Compose_|_Volume_Threshold_Percent')",
              tripwireVerdict: "@outputs('Compose_|_Tripwire_Verdict')",
              // The canary's whole state, in the report, because a run that
              // spoke to three people and a run where three people was the
              // whole book are indistinguishable from the counts alone.
              canaryClients: "@length(outputs('Compose_|_Canary_Ids'))",
              canaryAlertStatus: "@outputs('Compose_|_Canary_Alert_Status')",
              // Whether the org switch was even on. Without this line a
              // rehearsal that correctly produced drafts reads exactly like
              // one that silently failed to send.
              emailSendingEnabled: `@parameters('${SEND_EMAIL_PARAM}')`,
              emailsSent: "@length(body('Filter_|_Emails_Sent'))",
              // There is no riivo_SendEmail for WhatsApp: one live business
              // number, no draft mode, no redirect. So this line has no
              // "enabled" twin to report — whatsAppsSent is either a number of
              // real messages or a zero, and the touch rows say which.
              whatsAppsSent: "@length(body('Filter_|_WhatsApps_Sent'))",
              // Resolved rows are what #102/#103 will send — each now carries
              // a minted link and a rendered PDF, so "resolved" means ready,
              // not merely eligible. Held rows are clients this run
              // deliberately says nothing to, each carrying the reason, so a
              // silent client is never a silent failure.
              resolvedTouches: "@length(variables('varTouches'))",
              heldTouches: "@length(variables('varHeld'))",
              touches: "@variables('varTouches')",
              held: "@variables('varHeld')",
              selection: "@variables('varSelected')",
            },
          },
        },
      },
    },
    schemaVersion: "1.0.0.0",
  };
}
