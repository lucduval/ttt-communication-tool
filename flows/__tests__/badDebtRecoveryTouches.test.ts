/**
 * Guards on the generated definition of
 * `Invoice - Scheduled - Send Bad Debt Recovery Touches` (issue #98).
 *
 * This flow is unattended by decision (D5), which removes every human check the
 * comms tool provided. It is also authored as JSON and pushed over the Web API,
 * so nothing but these assertions stands between a careless edit and a live
 * misfire. Each test below pins a property that is expensive to get wrong:
 *
 *  - the #98 slice must send NOTHING, so any send-shaped action is a bug;
 *  - Pending Settlement (463630002) means money is already in flight, and
 *    `statecode eq 0` alone sweeps it in — the trap an existing live flow
 *    (`...Send Overdue Payment SMS Reminders...`) is currently sitting in;
 *  - consent polarity is inverted between the two channels
 *    (`riivo_whatsappoptinout` true = opted IN, `donotemail` true = suppressed),
 *    so a copy-paste between them silently messages people who opted out;
 *  - the `riivo_campaignlastsent` recency test is the ONLY thing standing
 *    between a Power Automate retry and a duplicate send — there are no
 *    transactions here.
 *
 * #99 adds the campaign key and touch bookkeeping. Those assertions EVALUATE
 * the deployed WDL rather than string-matching it (see `evaluate` below), so
 * "the six campaign keys resolve correctly" is a claim about the definition
 * that ships, not about a TypeScript restatement of it. The expected names are
 * read from `convex/seedWhatsappTemplates.ts` — the list mirroring what is
 * approved in Meta — so the flow and the approved set cannot drift apart
 * silently.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  buildBadDebtRecoveryTouchesFlow,
  APPROVED_CAMPAIGN_TEMPLATES,
  FLOW_NAME,
  ONGOING_TEMPLATE_VARIABLE,
} from "../badDebtRecoveryTouches";

const flow = buildBadDebtRecoveryTouchesFlow();
const json = JSON.stringify(flow);
const definition = flow.properties.definition;

/** Every action in the definition, flattened out of the nested scopes. */
function allActions(
  actions: Record<string, any>,
  acc: Array<[string, any]> = [],
): Array<[string, any]> {
  for (const [name, action] of Object.entries(actions ?? {})) {
    acc.push([name, action]);
    if (action.actions) allActions(action.actions, acc);
    if (action.else?.actions) allActions(action.else.actions, acc);
    for (const c of Object.values<any>(action.cases ?? {})) {
      if (c.actions) allActions(c.actions, acc);
    }
  }
  return acc;
}

const actions = allActions(definition.actions);

const action = (name: string) => actions.find(([n]) => n === name)![1];
const composeInputs = (name: string): string => action(name).inputs;

/**
 * A reader for the slice of the Workflow Definition Language these composes
 * use, so the campaign-key tests exercise the expression that will actually
 * run in Power Automate instead of a TypeScript copy of its logic.
 *
 * `env` maps leaf source text — `outputs('Compose_|_Age_Band')` and friends —
 * to the value that leaf would have at runtime. Anything not in `env` must be
 * a literal or one of the functions below, so an expression that grows a new
 * dependency fails loudly here rather than silently passing.
 */
function evaluate(expression: string, env: Record<string, unknown>): unknown {
  let src = expression.startsWith("@") ? expression.slice(1) : expression;
  const leaves: unknown[] = [];
  for (const key of Object.keys(env).sort((a, b) => b.length - a.length)) {
    while (src.includes(key)) {
      src = src.replace(key, `«LEAF${leaves.length}»`);
      leaves.push(env[key]);
    }
  }

  let at = 0;
  const skip = () => {
    while (at < src.length && /\s/.test(src[at])) at++;
  };

  const value = (): unknown => {
    skip();
    const leaf = /^«LEAF(\d+)»/.exec(src.slice(at));
    if (leaf) {
      at += leaf[0].length;
      return leaves[Number(leaf[1])];
    }
    if (src[at] === "'") {
      const end = src.indexOf("'", at + 1);
      const literal = src.slice(at + 1, end);
      at = end + 1;
      return literal;
    }
    const number = /^-?\d+/.exec(src.slice(at));
    if (number) {
      at += number[0].length;
      return Number(number[0]);
    }
    const word = /^[A-Za-z]+/.exec(src.slice(at));
    if (!word) throw new Error(`cannot read at ${at}: ${src.slice(at, at + 40)}`);
    at += word[0].length;
    if (word[0] === "true" || word[0] === "false") return word[0] === "true";
    skip();
    if (src[at] !== "(") throw new Error(`expected ( after ${word[0]}`);
    at++;
    const args: unknown[] = [];
    skip();
    if (src[at] === ")") at++;
    else
      for (;;) {
        args.push(value());
        skip();
        if (src[at] === ",") {
          at++;
          continue;
        }
        if (src[at] === ")") {
          at++;
          break;
        }
        throw new Error(`expected , or ) at ${at}`);
      }
    return apply(word[0], args);
  };

  const apply = (fn: string, a: unknown[]): unknown => {
    switch (fn) {
      case "if":
        return a[0] ? a[1] : a[2];
      case "equals":
        return a[0] === a[1];
      case "less":
        return (a[0] as number) < (a[1] as number);
      case "greater":
        return (a[0] as number) > (a[1] as number);
      case "not":
        return !a[0];
      case "and":
        return a.every(Boolean);
      case "or":
        return a.some(Boolean);
      case "add":
        return (a[0] as number) + (a[1] as number);
      case "coalesce":
        return a.find((x) => x !== null && x !== undefined);
      case "empty":
        return Array.isArray(a[0]) ? a[0].length === 0 : !a[0];
      case "length":
        return (a[0] as unknown[]).length;
      case "concat":
        return a.join("");
      case "contains":
        return (a[0] as unknown[]).includes(a[1]);
      default:
        throw new Error(`unsupported WDL function in a tested expression: ${fn}`);
    }
  };

  const result = value();
  skip();
  if (at !== src.length) throw new Error(`trailing input: ${src.slice(at)}`);
  return result;
}

describe("the flow sends nothing at all", () => {
  it("creates no email row and performs no SendEmail", () => {
    for (const [name, action] of actions) {
      const params = action.inputs?.parameters ?? {};
      expect(
        params.entityName === "emails",
        `${name} touches the emails table`,
      ).toBe(false);
      expect(
        String(params.actionName ?? ""),
        `${name} performs a bound send`,
      ).not.toMatch(/SendEmail/i);
    }
  });

  it("makes no outbound HTTP call of any kind", () => {
    const http = actions.filter(([, a]) => a.type === "Http");
    expect(http.map(([n]) => n)).toEqual([]);
  });

  it("names no Meta, WhatsApp or SMS endpoint anywhere in the definition", () => {
    expect(json).not.toMatch(/graph\.facebook\.com|bulksms|clickatell/i);
  });

  it("writes nothing to Dataverse except the touch bookkeeping on riivo_baddebts", () => {
    // #98 asserted zero writes. #99 adds exactly two — the first-touch and
    // repeat-touch patches — and nothing else may appear.
    for (const [name, action] of actions) {
      const op = action.inputs?.host?.operationId;
      if (!["CreateRecord", "UpdateRecord", "DeleteRecord"].includes(op)) continue;
      expect([name, op, action.inputs.parameters.entityName]).toEqual([
        name,
        "UpdateRecord",
        "riivo_baddebts",
      ]);
    }
  });

  it("cannot advance a counter, because nothing is sent to advance it", () => {
    // The bookkeeping gate is a send OUTCOME, not test mode: turning
    // riivo_ReminderTestMode off before #102/#103 land must still record no
    // touch. #102/#103 replace this compose with the real channel results —
    // which is exactly when this test should fail and be updated.
    const outcome = actions.find(([n]) => n === "Compose_|_Send_Outcome")![1];
    expect(outcome.inputs).toEqual({ email: false, whatsApp: false });
    expect(
      composeInputs("Compose_|_Touch_Sent"),
    ).toContain("outputs('Compose_|_Send_Outcome')");
  });
});

describe("invoice status selection", () => {
  const invoiceFilter = actions.find(
    ([n]) => n === "List_rows_|_Invoice_In_Scope",
  )![1].inputs.parameters["$filter"];

  it("chases Open and Partially Paid", () => {
    expect(invoiceFilter).toContain("958140000");
    expect(invoiceFilter).toContain("463630001");
  });

  it.each([
    ["463630002", "Payment Received - Pending Settlement"],
    ["958140003", "Paid"],
    ["958140004", "Cancelled"],
  ])("never chases %s (%s)", (code) => {
    expect(invoiceFilter).not.toContain(`statuscode eq ${code}`);
  });

  it("does not rely on statecode alone, which would sweep in Pending Settlement", () => {
    expect(invoiceFilter).toMatch(/statuscode eq/);
  });

  it("reads outstanding value from ttt_outstanding, never an original total", () => {
    expect(invoiceFilter).toContain("ttt_outstanding gt 0");
    expect(json).not.toMatch(/ttt_totalamountnew|ttt_totalwithinterest/);
  });
});

describe("consent, which is not a tuning knob", () => {
  const composes = Object.fromEntries(
    actions.map(([n, a]) => [n, JSON.stringify(a.inputs ?? "")]),
  );

  it("treats riivo_whatsappoptinout TRUE as opted in", () => {
    // Polarity confirmed against the proven cadence flow c430ace5, which reads
    // `equals(coalesce(riivo_whatsappoptinout, true), true)`. Inverting this
    // would message exactly the people who opted out.
    expect(composes["Compose_|_Wa_Allowed"]).toContain(
      "coalesce(outputs('Get_|_Payer_Contact')?['body/riivo_whatsappoptinout'], true), true)",
    );
  });

  it("treats donotemail and donotbulkemail TRUE as suppressed", () => {
    const email = composes["Compose_|_Email_Allowed"];
    expect(email).toContain("donotemail");
    expect(email).toContain("donotbulkemail");
    expect(email).toMatch(/not\(/);
  });

  it("keeps the channels independent, so one suppression does not drop the client", () => {
    // A client with donotemail set must still be selectable for WhatsApp.
    expect(composes["Compose_|_Wa_Allowed"]).not.toContain("donotemail");
    expect(composes["Compose_|_Email_Allowed"]).not.toContain(
      "whatsappoptinout",
    );
  });

  it("requires a mobile number before WhatsApp is considered allowed", () => {
    expect(composes["Compose_|_Wa_Allowed"]).toContain(
      "icon_formattedmobilenumber",
    );
  });

  it("drops a client only when BOTH channels are suppressed", () => {
    const keep = JSON.stringify(
      actions.find(([n]) => n === "Condition_|_Any_Channel_Allowed")![1]
        .expression,
    );
    expect(keep).toContain("or");
  });
});

describe("the cadence guard is the only defence against a duplicate", () => {
  const filter = actions.find(([n]) => n === "List_rows_|_Open_BadDebts")![1]
    .inputs.parameters["$filter"];

  it("filters on riivo_campaignlastsent in the query, not after the fact", () => {
    expect(filter).toContain("riivo_campaignlastsent");
  });

  it("lets a never-touched record through", () => {
    expect(filter).toContain("riivo_campaignlastsent eq null");
  });

  it("selects only open bad-debt records", () => {
    expect(filter).toContain("statecode eq 0");
  });

  it("takes the gap from an environment variable rather than a literal", () => {
    const cutoff = JSON.stringify(
      actions.find(([n]) => n === "Compose_|_Last_Sent_Cutoff")![1].inputs,
    );
    expect(cutoff).toContain("riivo_BadDebtMinDaysBetweenTouches");
    expect(cutoff).not.toMatch(/-\s*\d+\s*,/);
  });
});

describe("recurrence", () => {
  const rec = definition.triggers.Recurrence.recurrence;

  it("runs Monday and Thursday only", () => {
    expect(rec.frequency).toBe("Week");
    expect(rec.schedule.weekDays).toEqual(["Monday", "Thursday"]);
  });

  it("runs in South Africa Standard Time", () => {
    expect(rec.timeZone).toBe("South Africa Standard Time");
  });

  it("clears the 09:00 reminder flows and the 09:30 bad-debt digest", () => {
    // `Invoice - Scheduled - Bad Debt Referral & Owner Digest` (dd5a766f) runs
    // daily at 09:30 and CREATES riivo_baddebt rows. Reading the table while it
    // writes is a race, so this flow must not share that slot either.
    const hour = Number(rec.schedule.hours[0]);
    const minute = Number(rec.schedule.minutes[0]);
    expect(hour).toBe(9);
    expect(minute).toBeGreaterThan(30);
  });
});

describe("selection shape", () => {
  it("emits exactly one row per client", () => {
    expect(actions.map(([n]) => n)).toContain("Apply_to_each_|_Client");
    const sel = JSON.stringify(
      actions.find(([n]) => n === "Compose_|_Selected_For_Client")![1].inputs,
    );
    expect(sel).toMatch(/^"@first\(/);
  });

  it("keeps the NEWEST in-scope invoice per D10", () => {
    const newest = JSON.stringify(
      actions.find(([n]) => n === "Compose_|_Newest_Ticks")![1].inputs,
    );
    expect(newest).toContain("max(");
  });

  it("caps loop concurrency so Dataverse limits are honoured (R8)", () => {
    for (const [name, action] of actions) {
      if (action.type !== "Foreach") continue;
      expect(
        action.runtimeConfiguration?.concurrency?.repetitions,
        `${name} is uncapped`,
      ).toBeLessThanOrEqual(5);
    }
  });
});

describe("configuration and naming", () => {
  it("follows naming-standard.md: three segments, ' - ', Title Case", () => {
    expect(FLOW_NAME).toBe(
      "Invoice - Scheduled - Send Bad Debt Recovery Touches",
    );
    expect(FLOW_NAME.split(" - ")).toHaveLength(3);
  });

  it("hardcodes no secret or endpoint", () => {
    expect(json).not.toMatch(/x-functions-key|azurewebsites\.net/i);
  });

  it("honours the test-mode environment variable", () => {
    expect(json).toContain("riivo_ReminderTestMode");
  });
});

describe("campaign key -> template (#99)", () => {
  const ongoingParam = Object.entries<any>(definition.parameters).find(
    ([, p]) => p.metadata?.schemaName === ONGOING_TEMPLATE_VARIABLE,
  )!;
  const ongoingTemplate: string = ongoingParam[1].defaultValue;

  /** Run the deployed composes in the order the flow runs them. */
  function resolve(ageDays: number, hasPaidBefore: boolean, touch: number) {
    const relationship = evaluate(composeInputs("Compose_|_Relationship"), {
      "outputs('List_rows_|_Client_Paid_History')?['body/value']": hasPaidBefore
        ? [{ new_invoicesid: "a-paid-invoice" }]
        : [],
    });
    const ageBand = evaluate(composeInputs("Compose_|_Age_Band"), {
      "outputs('Compose_|_Invoice_Age_Days')": ageDays,
    });
    const touchDay = evaluate(composeInputs("Compose_|_Touch_Day"), {
      "outputs('Compose_|_Touch_Number')": touch,
    });
    const env = {
      "outputs('Compose_|_Invoice_Age_Days')": ageDays,
      "outputs('Compose_|_Touch_Number')": touch,
      "outputs('Compose_|_Age_Band')": ageBand,
      "outputs('Compose_|_Relationship')": relationship,
      "outputs('Compose_|_Touch_Day')": touchDay,
      [`parameters('${ongoingParam[0]}')`]: ongoingTemplate,
    };
    const templateName = evaluate(composeInputs("Compose_|_Template_Name"), env);
    const approved = evaluate(composeInputs("Compose_|_Template_Approved"), {
      ...env,
      "outputs('Compose_|_Template_Name')": templateName,
      "outputs('Compose_|_Approved_Templates')": APPROVED_CAMPAIGN_TEMPLATES,
    });
    const holdReason = evaluate(composeInputs("Compose_|_Hold_Reason"), {
      ...env,
      "outputs('Compose_|_Template_Name')": templateName,
    });
    return { ageBand, relationship, templateName, approved, holdReason };
  }

  it("offers exactly the 24 templates that are approved in Meta", () => {
    // convex/seedWhatsappTemplates.ts mirrors the Meta-approved set: the app
    // can only send a template that exists there, so it is the list to check
    // against rather than a second hand-maintained copy in this file.
    const seeded = [
      ...readFileSync(
        new URL("../../convex/seedWhatsappTemplates.ts", import.meta.url),
        "utf8",
      ).matchAll(/metaTemplateId: "(bad_debt_wa_[^"]+)"/g),
    ].map((m) => m[1]);

    expect(seeded).toHaveLength(24);
    expect([...APPROVED_CAMPAIGN_TEMPLATES].sort()).toEqual([...seeded].sort());
  });

  it.each([
    [45, true, 1, "bad_debt_wa_30_90_paid_before_day0"],
    [45, true, 2, "bad_debt_wa_30_90_paid_before_day10"],
    [45, true, 3, "bad_debt_wa_30_90_paid_before_day25"],
    [45, true, 4, "bad_debt_wa_30_90_paid_before_day40"],
    [45, false, 1, "bad_debt_wa_30_90_never_paid_day0"],
    [45, false, 2, "bad_debt_wa_30_90_never_paid_day10"],
    [45, false, 3, "bad_debt_wa_30_90_never_paid_day25"],
    [45, false, 4, "bad_debt_wa_30_90_never_paid_day40"],
    [200, true, 1, "bad_debt_wa_90d_1y_paid_before_day0"],
    [200, true, 2, "bad_debt_wa_90d_1y_paid_before_day10"],
    [200, true, 3, "bad_debt_wa_90d_1y_paid_before_day25"],
    [200, true, 4, "bad_debt_wa_90d_1y_paid_before_day40"],
    [200, false, 1, "bad_debt_wa_90d_1y_never_paid_day0"],
    [200, false, 2, "bad_debt_wa_90d_1y_never_paid_day10"],
    [200, false, 3, "bad_debt_wa_90d_1y_never_paid_day25"],
    [200, false, 4, "bad_debt_wa_90d_1y_never_paid_day40"],
    [700, true, 1, "bad_debt_wa_1_3y_paid_before_day0"],
    [700, true, 2, "bad_debt_wa_1_3y_paid_before_day10"],
    [700, true, 3, "bad_debt_wa_1_3y_paid_before_day25"],
    [700, true, 4, "bad_debt_wa_1_3y_paid_before_day40"],
    [700, false, 1, "bad_debt_wa_1_3y_never_paid_day0"],
    [700, false, 2, "bad_debt_wa_1_3y_never_paid_day10"],
    [700, false, 3, "bad_debt_wa_1_3y_never_paid_day25"],
    [700, false, 4, "bad_debt_wa_1_3y_never_paid_day40"],
  ])(
    "age %i days, paid-before %s, touch %i -> %s",
    (ageDays, hasPaidBefore, touch, expected) => {
      const { templateName, approved } = resolve(ageDays, hasPaidBefore, touch);
      expect(templateName).toBe(expected);
      expect(approved).toBe(true);
    },
  );

  it.each([
    [29, "", "younger"],
    [30, "30_90", ""],
    [89, "30_90", ""],
    [90, "90d_1y", ""],
    [364, "90d_1y", ""],
    [365, "1_3y", ""],
    [1095, "1_3y", ""],
    [1096, "", "prescribed"],
  ])(
    "an invoice %i days old bands as %s — the In-scope window is not a tuning knob",
    (ageDays, band) => {
      expect(resolve(ageDays, true, 1).ageBand).toBe(band);
    },
  );

  it.each([
    [29, "younger than 30 days"],
    [1096, "prescribed"],
  ])(
    "holds rather than guessing a band for an invoice %i days old",
    (ageDays, reason) => {
      // Banding a prescribed debt into 1-3y would put a client one
      // acknowledgement away from reviving a debt into the FINAL NOTICE copy.
      const held = resolve(ageDays, true, 1);
      expect(held.templateName).toBe("");
      expect(held.approved).toBe(false);
      expect(held.holdReason).toContain(reason);
    },
  );

  it("derives relationship from the client's payment history, not the invoice", () => {
    expect(resolve(200, true, 1).relationship).toBe("paid_before");
    expect(resolve(200, false, 1).relationship).toBe("never_paid");

    const filter = action("List_rows_|_Client_Paid_History").inputs.parameters[
      "$filter"
    ];
    expect(filter).toContain("_ttt_customer_value eq ");
    expect(filter).toContain("items('Apply_to_each_|_Selected')?['clientId']");
    expect(filter).toContain("statuscode eq 958140003"); // Paid
    expect(filter).not.toContain("new_invoicesid eq");
  });

  it("derives the age band from the invoice being chased, freshly each run", () => {
    // riivo_baddebt.riivo_invoiceage is stamped at row creation and does not
    // age: banding on it would freeze a debtor in the band they entered at.
    expect(composeInputs("Compose_|_Invoice_Age_Days")).toContain(
      "items('Apply_to_each_|_Selected')?['invoiceCreatedOn']",
    );
    expect(composeInputs("Compose_|_Invoice_Age_Days")).toContain("utcNow()");
    expect(json).not.toContain("riivo_invoiceage");
  });

  it.each([5, 6, 12, 40])(
    "touch %i falls back to the D12 general template and never wraps to touch 1",
    (touch) => {
      const { templateName, approved } = resolve(200, true, touch);
      expect(templateName).toBe(ongoingTemplate);
      expect(approved).toBe(true);
      expect(APPROVED_CAMPAIGN_TEMPLATES).not.toContain(templateName);
      expect(templateName).not.toMatch(/_day0$/);
    },
  );

  it("reads the D12 template from its environment variable, never a literal", () => {
    expect(composeInputs("Compose_|_Template_Name")).toContain(
      `parameters('${ongoingParam[0]}')`,
    );
    expect(ongoingParam[1].metadata.schemaName).toBe(ONGOING_TEMPLATE_VARIABLE);
  });

  it("asserts a resolved name against the approved set rather than assuming it", () => {
    const approvedOf = (templateName: string, touch: number) =>
      evaluate(composeInputs("Compose_|_Template_Approved"), {
        "outputs('Compose_|_Touch_Number')": touch,
        "outputs('Compose_|_Template_Name')": templateName,
        "outputs('Compose_|_Approved_Templates')": APPROVED_CAMPAIGN_TEMPLATES,
      });

    expect(approvedOf("bad_debt_wa_90d_1y_paid_before_day10", 2)).toBe(true);
    // A band or relationship token that drifts produces a plausible-looking
    // name Meta has never seen. It must be held, not sent.
    expect(approvedOf("bad_debt_wa_90d_1yr_paid_before_day10", 2)).toBe(false);
    expect(approvedOf("bad_debt_wa_90d_1y_paidbefore_day10", 2)).toBe(false);
    expect(approvedOf("", 1)).toBe(false);
    // Past touch 4 the name comes from config, so the check is that it is set.
    expect(approvedOf("", 5)).toBe(false);
  });

  it("holds a client rather than sending an unapproved template", () => {
    const held = action("Condition_|_Template_Approved").else.actions;
    expect(Object.keys(held)).toEqual(["Append_to_array_variable_|_Held"]);
    expect(
      JSON.stringify(held["Append_to_array_variable_|_Held"].inputs),
    ).toContain("Compose_|_Hold_Reason");
  });

  it("reports resolved and held rows so a silent client is never a silent failure", () => {
    const report = JSON.stringify(composeInputs("Compose_|_Dry_Run_Report"));
    expect(report).toContain("varTouches");
    expect(report).toContain("varHeld");
  });
});

describe("touch bookkeeping (#99)", () => {
  const firstTouch = action("Update_|_Touch_First").inputs.parameters;
  const repeatTouch = action("Update_|_Touch_Repeat").inputs.parameters;

  it("increments riivo_campaignsendcount by exactly one per touch", () => {
    expect(composeInputs("Compose_|_Touch_Number")).toBe(
      "@add(coalesce(items('Apply_to_each_|_Selected')?['sendCount'], 0), 1)",
    );
    for (const patch of [firstTouch, repeatTouch]) {
      expect(patch["item/riivo_campaignsendcount"]).toBe(
        "@outputs('Compose_|_Touch_Number')",
      );
    }
    // Read + 1, never a recount: the count the template was chosen from is the
    // count written back, so the two halves cannot disagree.
    expect(
      evaluate(composeInputs("Compose_|_Touch_Number"), {
        "items('Apply_to_each_|_Selected')?['sendCount']": 3,
      }),
    ).toBe(4);
    expect(
      evaluate(composeInputs("Compose_|_Touch_Number"), {
        "items('Apply_to_each_|_Selected')?['sendCount']": null,
      }),
    ).toBe(1);
  });

  it("stamps riivo_campaignlastsent on every touch", () => {
    for (const patch of [firstTouch, repeatTouch]) {
      expect(patch["item/riivo_campaignlastsent"]).toBe("@utcNow()");
    }
  });

  it("stamps riivo_campaignfirstsent on the first touch only", () => {
    expect(firstTouch["item/riivo_campaignfirstsent"]).toBe("@utcNow()");
    // Absent, not null: a null would blank a date already told to a client.
    expect("item/riivo_campaignfirstsent" in repeatTouch).toBe(false);
  });

  it("branches on the stored date, so a reset counter cannot rewrite it", () => {
    expect(JSON.stringify(action("Condition_|_First_Touch").expression)).toContain(
      "empty(coalesce(items('Apply_to_each_|_Selected')?['firstSent'], ''))",
    );
  });

  it("patches only the fields it owns, merging monotonically", () => {
    // riivo_campaignbounced and riivo_campaignlastreply belong to the bounce
    // and reply paths. A blind overwrite has already erased a run's figures on
    // this table once, which is why the patches are enumerated here.
    for (const patch of [firstTouch, repeatTouch]) {
      expect(Object.keys(patch).filter((k) => k.startsWith("item/")).sort()).toEqual(
        patch === firstTouch
          ? [
              "item/riivo_campaignfirstsent",
              "item/riivo_campaignlastsent",
              "item/riivo_campaignsendcount",
            ]
          : ["item/riivo_campaignlastsent", "item/riivo_campaignsendcount"],
      );
      expect(patch.entityName).toBe("riivo_baddebts");
      expect(patch.recordId).toBe(
        "@items('Apply_to_each_|_Selected')?['badDebtId']",
      );
    }
  });

  it("records a touch only where a send actually succeeded", () => {
    const gate = JSON.stringify(action("Condition_|_Touch_Sent").expression);
    expect(gate).toContain("Compose_|_Touch_Sent");
    // Both patches sit inside that gate, not beside it.
    const inside = allActions(
      action("Condition_|_Touch_Sent").actions,
    ).map(([n]) => n);
    expect(inside).toContain("Update_|_Touch_First");
    expect(inside).toContain("Update_|_Touch_Repeat");
  });

  it("reads the touch state once, in the same query that selects candidates", () => {
    const select = action("List_rows_|_Open_BadDebts").inputs.parameters["$select"];
    expect(select).toContain("riivo_campaignsendcount");
    expect(select).toContain("riivo_campaignfirstsent");
  });
});
