/**
 * `Invoice - Scheduled - Send Bad Debt Recovery Touches` — issues #98–#101.
 *
 * The selection half of the bad-debt cadence, the campaign key that says WHICH
 * message each selected client is due, the two inputs that message needs, and
 * the one brake that looks at the run as a whole — and deliberately nothing
 * else: this flow still sends nothing at all. The channels arrive in #102/#103.
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
 * #99 adds two halves of one mechanism. `riivo_campaignsendcount` chooses the
 * template, and the touch increments it, so template resolution and touch
 * bookkeeping cannot be built apart. Both are built here; the bookkeeping
 * WRITE is gated on a send having succeeded, and this slice sends nothing, so
 * the counter cannot advance yet even if someone flips test mode off early.
 * `Compose_|_Send_Outcome` is the seam #102/#103 replace.
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

/** The three verdicts the tripwire can reach. Only `proceed` runs the loop. */
const VERDICT = {
  PROCEED: "proceed",
  VOLUME: "volume",
  EMPTY: "empty",
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

          "Initialize_variable_|_Candidates": {
            runAfter: { "Compose_|_Last_Sent_Cutoff": ["Succeeded"] },
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
                "@concat('statecode eq 0 and (riivo_campaignlastsent eq null or riivo_campaignlastsent lt ', outputs('Compose_|_Last_Sent_Cutoff'), ')')",
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
              "item/riivo_outcome": `@if(equals(${verdict}, '${VERDICT.PROCEED}'), '${RUN_OUTCOME.PROCEEDED}', '${RUN_OUTCOME.ABORTED}')`,
              "item/riivo_abortreason": "@outputs('Compose_|_Tripwire_Reason')",
              "item/riivo_testmode": "@outputs('Compose_|_TestMode')",
            }),
          },

          "Condition_|_Tripwire_Tripped": {
            runAfter: { "Create_|_Run_Record": ["Succeeded"] },
            type: "If",
            expression: {
              and: [{ not: { equals: [`@${verdict}`, VERDICT.PROCEED] } }],
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

          "Initialize_variable_|_Touches": {
            // Everything below is reached only by a run the tripwire cleared:
            // Terminate ends the run where it stands, so the loop is never
            // entered on a park. Nothing had to move into a branch for that.
            runAfter: { "Condition_|_Tripwire_Tripped": ["Succeeded"] },
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

          // ---- campaign key -> template, and the touch it records (#99) ----
          "Apply_to_each_|_Selected": {
            foreach: "@variables('varSelected')",
            runAfter: { "Initialize_variable_|_Pdf_Done": ["Succeeded"] },
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
                      "Append_to_array_variable_|_Touch": {
                        runAfter: {},
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
                          },
                        },
                      },

                      // THE SEAM #102/#103 REPLACE. Bookkeeping records a touch
                      // that happened; this slice performs no send, so both
                      // outcomes are literally false and no counter can move.
                      // Left as data rather than a condition on test mode so
                      // that flipping riivo_ReminderTestMode off before the
                      // send slices land still advances nothing.
                      "Compose_|_Send_Outcome": {
                        runAfter: {
                          "Append_to_array_variable_|_Touch": ["Succeeded"],
                        },
                        type: "Compose",
                        inputs: { email: false, whatsApp: false },
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
          "Update_|_Run_Record": {
            runAfter: { "Apply_to_each_|_Selected": ["Succeeded"] },
            ...dataverse("UpdateRecord", {
              entityName: RUN_TABLE_SET,
              recordId: `@outputs('Create_|_Run_Record')?['body/${RUN_TABLE_ID}']`,
              "item/riivo_resolvedcount": "@length(variables('varTouches'))",
              "item/riivo_heldcount": "@length(variables('varHeld'))",
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
