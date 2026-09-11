/**
 * `Invoice - Scheduled - Send Bad Debt Recovery Touches` — issues #98, #99.
 *
 * The selection half of the bad-debt cadence, plus the campaign key that says
 * WHICH message each selected client is due — and deliberately nothing else:
 * this flow still sends nothing at all. Minting, PDF generation and the
 * channels arrive in #100–#103.
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

export const FLOW_NAME = "Invoice - Scheduled - Send Bad Debt Recovery Touches";

/** Dataverse environment variable holding the minimum gap between touches. */
export const TOUCH_GAP_VARIABLE = "riivo_BadDebtMinDaysBetweenTouches";

const TEST_MODE_PARAM = "Reminder Test Mode (riivo_ReminderTestMode)";
const TOUCH_GAP_PARAM = `Bad Debt Min Days Between Touches (${TOUCH_GAP_VARIABLE})`;

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

/** Foreach concurrency cap. R8: uncapped loops trip service-protection limits. */
const capped = { concurrency: { repetitions: 1 } };

export function buildBadDebtRecoveryTouchesFlow() {
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
                  $select:
                    "new_invoicesid,new_name,createdon,ttt_outstanding,_ttt_customer_value",
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
          "Initialize_variable_|_Touches": {
            runAfter: { "Compose_|_Selected_Count": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: { variables: [{ name: "varTouches", type: "array", value: [] }] },
          },
          "Initialize_variable_|_Held": {
            runAfter: { "Initialize_variable_|_Touches": ["Succeeded"] },
            type: "InitializeVariable",
            inputs: { variables: [{ name: "varHeld", type: "array", value: [] }] },
          },

          // ---- campaign key -> template, and the touch it records (#99) ----
          "Apply_to_each_|_Selected": {
            foreach: "@variables('varSelected')",
            runAfter: { "Initialize_variable_|_Held": ["Succeeded"] },
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
                      },
                    },
                  },

                  // THE SEAM #102/#103 REPLACE. Bookkeeping records a touch
                  // that happened; this slice performs no send, so both
                  // outcomes are literally false and no counter can move. Left
                  // as data rather than a condition on test mode so that
                  // flipping riivo_ReminderTestMode off before the send slices
                  // land still advances nothing.
                  "Compose_|_Send_Outcome": {
                    runAfter: { "Append_to_array_variable_|_Touch": ["Succeeded"] },
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
                      and: [{ equals: ["@outputs('Compose_|_Touch_Sent')", true] }],
                    },
                    actions: {
                      // riivo_campaignfirstsent is stamped once, ever. The
                      // branch is on the field itself rather than on the count
                      // so that a reset counter cannot rewrite a date that has
                      // already been told to a client.
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
                        else: { actions: { "Update_|_Touch_Repeat": touchUpdate(false) } },
                      },
                    },
                    else: { actions: {} },
                  },
                },
                else: {
                  actions: {
                    "Append_to_array_variable_|_Held": {
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
                          reason: "@outputs('Compose_|_Hold_Reason')",
                        },
                      },
                    },
                  },
                },
              },
            },
          },

          "Compose_|_Dry_Run_Report": {
            runAfter: { "Apply_to_each_|_Selected": ["Succeeded"] },
            type: "Compose",
            inputs: {
              flow: FLOW_NAME,
              testMode: "@outputs('Compose_|_TestMode')",
              lastSentCutoff: "@outputs('Compose_|_Last_Sent_Cutoff')",
              candidatesBeforeCollapse: "@length(variables('varCandidates'))",
              selectedClients: "@outputs('Compose_|_Selected_Count')",
              // Resolved rows are what #100-#103 will send; held rows are
              // clients this run deliberately says nothing to, each carrying
              // the reason, so a silent client is never a silent failure.
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
