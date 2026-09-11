/**
 * `Invoice - Scheduled - Send Bad Debt Recovery Touches` — issue #98.
 *
 * The selection half of the bad-debt cadence, and deliberately nothing else:
 * this slice picks exactly the right clients twice a week and sends nothing at
 * all. Minting, PDF generation and the channels arrive in #99–#103.
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

const dataverse = (operationId: string, parameters: Record<string, unknown>) => ({
  type: "OpenApiConnection",
  inputs: {
    host: { ...DATAVERSE, operationId },
    parameters,
    authentication: "@parameters('$authentication')",
  },
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

          // sub(0, n) rather than a negative literal, so the gap is only ever
          // read from the environment variable.
          "Compose_|_Last_Sent_Cutoff": {
            runAfter: { "Compose_|_TestMode": ["Succeeded"] },
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
                "riivo_baddebtid,_riivo_invoice_value,_riivo_client_value,riivo_campaignlastsent,riivo_outstandingamount",
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
          "Compose_|_Dry_Run_Report": {
            runAfter: { "Compose_|_Selected_Count": ["Succeeded"] },
            type: "Compose",
            inputs: {
              flow: FLOW_NAME,
              testMode: "@outputs('Compose_|_TestMode')",
              lastSentCutoff: "@outputs('Compose_|_Last_Sent_Cutoff')",
              candidatesBeforeCollapse: "@length(variables('varCandidates'))",
              selectedClients: "@outputs('Compose_|_Selected_Count')",
              selection: "@variables('varSelected')",
            },
          },
        },
      },
    },
    schemaVersion: "1.0.0.0",
  };
}
