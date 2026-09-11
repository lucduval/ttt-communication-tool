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
 *
 * #100 adds the token and the PDF, and one guarantee worth more than either:
 * no message goes out without its attachment. The tests below therefore care
 * less about the happy path than about what happens when a call fails — that
 * the client is held rather than sent a broken link, that their bookkeeping is
 * left alone so the next run retries them, and that their failure stays theirs
 * instead of ending the run for everyone behind them in a sequential loop.
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
 * Every assertion here walks a Workflow Definition Language tree: a
 * heterogeneous JSON shape the platform defines and TypeScript cannot, where
 * each node's fields depend on its `type`. `any` at the walk is honest, and
 * modelling the WDL schema to satisfy the rule would mean maintaining a second,
 * unverified description of Microsoft's format. Declared once here rather than
 * left as the 25 individual errors this file used to report.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  buildBadDebtRecoveryTouchesFlow,
  ALERT_CHILD_FLOW_ID,
  APPROVED_CAMPAIGN_TEMPLATES,
  CANARY_VARIABLE,
  DEFAULT_VOLUME_THRESHOLD_PERCENT,
  EMAIL_CHILD_FLOW_ID,
  FLOW_NAME,
  ONGOING_TEMPLATE_VARIABLE,
  PDF_CHILD_FLOW_ID,
  VOLUME_THRESHOLD_VARIABLE,
} from "../badDebtRecoveryTouches";
import {
  BASELINE_OUTCOMES,
  RUN_OUTCOME,
  RUN_TABLE_ATTRIBUTES,
  RUN_TABLE_ID,
  RUN_TABLE_SET,
  buildRunTableMetadata,
  buildRunTableAttributeMetadata,
} from "../badDebtRunTable";

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
      case "sub":
        return (a[0] as number) - (a[1] as number);
      case "mul":
        return (a[0] as number) * (a[1] as number);
      case "div":
        // WDL's div() on two integers is integer division: it truncates. The
        // tripwire's percentage leans on that, so the reader must too.
        return Math.trunc((a[0] as number) / (a[1] as number));
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
      case "string":
        // WDL's string() on an array or object produces JSON, which is how
        // the email payloads are built — String() would give "a,b".
        return typeof a[0] === "object" && a[0] !== null
          ? JSON.stringify(a[0])
          : String(a[0]);
      case "createArray":
        return a;
      case "formatNumber":
        // Only the one format this build uses; anything else should be a
        // loud failure rather than a quietly wrong number in an email.
        if (a[1] !== "N2") throw new Error(`formatNumber format ${a[1]}`);
        return (a[0] as number).toFixed(2);
      case "join":
        return (a[0] as unknown[]).join(a[1] as string);
      case "min":
        return Math.min(...(a as number[]));
      case "max":
        return Math.max(...(a as number[]));
      case "int":
        // WDL's int() throws on anything non-numeric, and so must this: the
        // Retry-After clamp leans on that failure being loud.
        if (!/^-?\d+$/.test(String(a[0]))) throw new Error(`int(${a[0]})`);
        return Number(a[0]);
      default:
        throw new Error(`unsupported WDL function in a tested expression: ${fn}`);
    }
  };

  const result = value();
  skip();
  if (at !== src.length) throw new Error(`trailing input: ${src.slice(at)}`);
  return result;
}

/**
 * The same reader, for the structured `expression` object on a Condition —
 * `{ and: [{ equals: [...] }] }` — so a branch is tested as the flow will take
 * it rather than as a restatement of it.
 */
function evaluateCondition(
  expression: any,
  env: Record<string, unknown>,
): boolean {
  const leaf = (operand: unknown) =>
    typeof operand === "string" && operand.startsWith("@")
      ? evaluate(operand, env)
      : operand;

  const [operator, operands] = Object.entries(expression)[0] as [string, any];
  switch (operator) {
    case "and":
      return operands.every((o: any) => evaluateCondition(o, env));
    case "or":
      return operands.some((o: any) => evaluateCondition(o, env));
    case "not":
      return !evaluateCondition(operands, env);
    case "equals":
      return leaf(operands[0]) === leaf(operands[1]);
    case "greater":
      return (leaf(operands[0]) as number) > (leaf(operands[1]) as number);
    default:
      throw new Error(`unsupported condition operator: ${operator}`);
  }
}

/**
 * #102 turns the email channel on, and these are the assertions that did NOT
 * change when it did — which is the interesting half. The flow now sends, but
 * it still writes no `email` row, performs no bound `SendEmail`, and makes no
 * outbound HTTP call but the mint: all of that belongs to the house child, and
 * the day any of it reappears here is the day this build started
 * reimplementing something that already has a home.
 */
describe("what this flow still does not do itself", () => {
  it("creates no email row and performs no SendEmail of its own", () => {
    // The house child 0d0bc4d6 owns the email row, the attachment and the
    // bound SendEmail. Before #102 this assertion said "nothing sends"; now it
    // says "nothing sends HERE", which is the property worth keeping — a
    // second implementation of the send would mean a second branded template,
    // a second unsubscribe footer and a second attachment ordering to get
    // right.
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

  it("makes no outbound HTTP call except minting a payment token", () => {
    // #98/#99 asserted zero. #100 adds exactly one, and it is an input to a
    // message rather than a message: anything else appearing here is a send.
    const http = actions.filter(([, a]) => a.type === "Http");
    expect(http.map(([n]) => n)).toEqual(["HTTP_|_Mint_Token"]);
    expect(http[0][1].inputs.uri).toMatch(/\/mint-token$/);
  });

  it("names no Meta, WhatsApp or SMS endpoint anywhere in the definition", () => {
    expect(json).not.toMatch(/graph\.facebook\.com|bulksms|clickatell/i);
  });

  it("writes nothing to Dataverse but the touch bookkeeping, a minted token and its own run history", () => {
    // #98 asserted zero writes. #99 added the first-touch and repeat-touch
    // patches; #100 adds the token write-back; #101 adds the two writes to its
    // own run table — which touch no client record and no client-facing field.
    // Five, enumerated by name and table, so a sixth cannot arrive unnoticed.
    const writes = actions
      .filter(([, a]) =>
        ["CreateRecord", "UpdateRecord", "DeleteRecord"].includes(
          a.inputs?.host?.operationId,
        ),
      )
      .map(([name, a]) => [
        name,
        a.inputs.host.operationId,
        a.inputs.parameters.entityName,
      ]);

    expect(writes.sort()).toEqual([
      ["Create_|_Run_Record", "CreateRecord", RUN_TABLE_SET],
      ["Update_|_Invoice_Token", "UpdateRecord", "new_invoiceses"],
      ["Update_|_Run_Record", "UpdateRecord", RUN_TABLE_SET],
      ["Update_|_Touch_First", "UpdateRecord", "riivo_baddebts"],
      ["Update_|_Touch_Repeat", "UpdateRecord", "riivo_baddebts"],
    ]);
  });

  it("still says nothing over WhatsApp, which is #103", () => {
    const outcome = actions.find(([n]) => n === "Compose_|_Send_Outcome")![1];
    expect(outcome.inputs.whatsApp).toBe(false);
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
    // The header NAME is part of the contract and has to appear. Its value,
    // and the function app's address, must not: the key is stored as a
    // plaintext default on its environment variable, so a defaultValue here
    // would copy a live secret into git and into every solution export.
    expect(json).not.toMatch(/azurewebsites\.net/i);
    expect(json).not.toMatch(/"x-functions-key"\s*:\s*"(?!@parameters\()/);

    for (const schemaName of [
      "riivo_PaymentLink_BaseUrl",
      "riivo_PaymentLink_FunctionKey",
    ]) {
      const param = Object.values<any>(definition.parameters).find(
        (p) => p.metadata?.schemaName === schemaName,
      );
      expect(param, `${schemaName} is not declared`).toBeDefined();
      expect(param.defaultValue, `${schemaName} carries a default`).toBe("");
    }
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

describe("payment token and PDF (#100)", () => {
  const mint = action("HTTP_|_Mint_Token");
  const pdf = action("Run_Child_|_Generate_PDF");
  const tokenPatch = action("Update_|_Invoice_Token").inputs.parameters;
  const param = (schemaName: string) =>
    Object.entries<any>(definition.parameters).find(
      ([, p]) => p.metadata?.schemaName === schemaName,
    )!;

  it("mints only when the invoice has no token, so a retry costs nothing", () => {
    const needed = (existingToken: string, linkEnabled = true) =>
      evaluateCondition(action("Condition_|_Mint_Needed").expression, {
        "outputs('Compose_|_Existing_Token')": existingToken,
        "outputs('Compose_|_Link_Enabled')": linkEnabled,
      });

    expect(needed("")).toBe(true);
    expect(needed("an-existing-token")).toBe(false);
    // Every approved template carries a Pay-now button, so with links off
    // there is no compliant message to send: hold, rather than mint a token
    // for a button pointing at a switched-off endpoint.
    expect(needed("", false)).toBe(false);

    // And the existing token is read from the row the selection already
    // fetched, not re-read at mint time.
    expect(composeInputs("Compose_|_Existing_Token")).toContain(
      "items('Apply_to_each_|_Selected')?['paymentToken']",
    );
    const select = action("List_rows_|_Invoice_In_Scope").inputs.parameters[
      "$select"
    ];
    expect(select).toContain("riivo_paymenttoken");
  });

  it("posts the documented mint contract, with both values from config", () => {
    expect(mint.inputs.method).toBe("POST");
    expect(mint.inputs.uri).toBe(
      `@{parameters('${param("riivo_PaymentLink_BaseUrl")[0]}')}/mint-token`,
    );
    expect(mint.inputs.headers["x-functions-key"]).toBe(
      `@parameters('${param("riivo_PaymentLink_FunctionKey")[0]}')`,
    );
    expect(mint.inputs.body).toEqual({
      invoiceId: "@{items('Apply_to_each_|_Selected')?['invoiceId']}",
    });
  });

  it("writes the minted token back, and never moves a date already sent", () => {
    // The write happens on a FRESH mint only: an invoice that arrived with a
    // token is never patched, so nothing can overwrite a token a client is
    // already holding a link to.
    const writes = (existingToken: string, resolvedToken: string) =>
      evaluateCondition(action("Condition_|_Token_Minted").expression, {
        "outputs('Compose_|_Existing_Token')": existingToken,
        "outputs('Compose_|_Payment_Token')": resolvedToken,
      });
    expect(writes("", "freshly-minted")).toBe(true);
    expect(writes("already-have-one", "already-have-one")).toBe(false);
    expect(writes("", "")).toBe(false); // a mint that produced nothing

    expect(tokenPatch.entityName).toBe("new_invoiceses");
    expect(tokenPatch.recordId).toBe(
      "@items('Apply_to_each_|_Selected')?['invoiceId']",
    );
    expect(tokenPatch["item/riivo_paymenttoken"]).toBe(
      "@outputs('Compose_|_Payment_Token')",
    );
    // Monotonic, for the same reason the touch patches are: a date a client
    // has already been told must not be rewritten by a later run.
    const stamp = (existing: string) =>
      evaluate(tokenPatch["item/riivo_paymentlinksenton"], {
        "items('Apply_to_each_|_Selected')?['paymentLinkSentOn']": existing,
        "utcNow()": "2026-09-11T09:45:00Z",
      });
    expect(stamp("")).toBe("2026-09-11T09:45:00Z");
    expect(stamp("2026-01-02T00:00:00Z")).toBe("2026-01-02T00:00:00Z");

    // Nothing else on the invoice is touched.
    expect(Object.keys(tokenPatch).filter((k) => k.startsWith("item/")).sort()).toEqual(
      ["item/riivo_paymentlinksenton", "item/riivo_paymenttoken"],
    );
  });

  it("prefers an existing token over a freshly minted one", () => {
    const token = (existing: string, minted: string | null) =>
      evaluate(composeInputs("Compose_|_Payment_Token"), {
        "outputs('Compose_|_Existing_Token')": existing,
        "body('HTTP_|_Mint_Token')?['token']": minted,
      });
    expect(token("already-have-one", "freshly-minted")).toBe("already-have-one");
    expect(token("", "freshly-minted")).toBe("freshly-minted");
    // A mint that answered with no token leaves it empty — which aborts.
    expect(token("", null)).toBe("");
  });

  it("gets the PDF from the child flow, never from the Azure function", () => {
    expect(pdf.type).toBe("Workflow");
    expect(pdf.inputs.host.workflowReferenceName).toBe(PDF_CHILD_FLOW_ID);
    expect(pdf.inputs.body).toEqual({
      invoiceId: "@items('Apply_to_each_|_Selected')?['invoiceId']",
    });
    // The child owns the line-item payload and the endpoint. Naming either
    // here would be the duplication it exists to prevent.
    expect(json).not.toMatch(/riivo_InvoiceGen2_Endpoint|riivo_invoicelineitems/i);
  });

  it("keeps the document source and the payment link each in ONE place", () => {
    // The document source becomes a Statement Issue GUID later. That swap is
    // safe only while every consumer reads these two composes.
    expect(json.split("body('Run_Child_|_Generate_PDF')?['pdfBase64']")).toHaveLength(2);
    expect(json.split("'/p/'")).toHaveLength(2);
    // #101 and #102 each add a child reference, so the count is no longer 1 —
    // but the property this test is really about still holds: every child flow
    // is called from exactly one site, and every GUID is dev's. All three are
    // re-pointed by hand on promotion (see the module's PROMOTION HAZARD note).
    // The alert child is named twice because a park and a canary are different
    // events; both are still the same one GUID.
    const children = actions
      .filter(([, a]) => a.type === "Workflow")
      .map(([name, a]) => [name, a.inputs.host.workflowReferenceName]);
    expect(children).toEqual([
      ["Run_Child_|_Volume_Alert", ALERT_CHILD_FLOW_ID],
      ["Run_Child_|_Canary_Alert", ALERT_CHILD_FLOW_ID],
      ["Run_Child_|_Generate_PDF", PDF_CHILD_FLOW_ID],
      ["Run_Child_|_Send_Email", EMAIL_CHILD_FLOW_ID],
    ]);
    expect(json.split("workflowReferenceName")).toHaveLength(
      children.length + 1,
    );
  });

  it("carries the PDF's size into the report, never its bytes", () => {
    const touch = JSON.stringify(
      action("Append_to_array_variable_|_Touch").inputs.value,
    );
    expect(touch).toContain("length(coalesce(outputs('Compose_|_Document')");
    expect(touch).not.toMatch(/pdfBase64|\['base64'\][^)]*"/);
    expect(JSON.stringify(composeInputs("Compose_|_Dry_Run_Report"))).not.toContain(
      "base64",
    );
  });
});

describe("no message without its attachment (#100)", () => {
  /** `Compose_|_Prepare_Ok`, as the flow will evaluate it. */
  const prepareOk = (failures: unknown[], token: unknown, base64: unknown) =>
    evaluate(composeInputs("Compose_|_Prepare_Ok"), {
      "body('Filter_|_Prepare_Failures')": failures,
      "outputs('Compose_|_Payment_Token')": token,
      "outputs('Compose_|_Document')?['base64']": base64,
    });

  it("proceeds only with BOTH a token and a rendered document", () => {
    expect(prepareOk([], "a-token", "JVBERi0=")).toBe(true);
  });

  it.each([
    ["a mint failure", [], "", "JVBERi0="],
    ["a PDF failure", [], "a-token", ""],
    ["an action that failed inside the scope", [{ name: "X" }], "a-token", "JVBERi0="],
    ["a scope that never ran at all", [{ name: "X" }], null, null],
  ])("holds the client on %s", (_case, failures, token, base64) => {
    expect(prepareOk(failures, token, base64)).toBe(false);
  });

  it("leaves an aborted client's bookkeeping exactly as it was", () => {
    // This is what makes "the next run picks them up again" true: the
    // selection query filters on riivo_campaignlastsent, so an untouched
    // record is selected again unchanged.
    const aborted = allActions(action("Condition_|_Prepare_Ok").else.actions);
    expect(aborted.map(([n]) => n)).toEqual([
      "Append_to_array_variable_|_Held_Prepare",
    ]);
    for (const [name, a] of aborted) {
      expect([name, a.inputs?.host?.operationId]).toEqual([name, undefined]);
    }
  });

  it("tells the reader WHY a client was silent", () => {
    const reason = composeInputs("Compose_|_Prepare_Hold_Reason");
    expect(reason).toContain("riivo_PaymentLinkEnabled");
    expect(reason).toContain("no payment token");
    expect(reason).toContain("no invoice PDF");
    expect(
      JSON.stringify(action("Append_to_array_variable_|_Held_Prepare").inputs),
    ).toContain("Compose_|_Prepare_Hold_Reason");
  });

  it("contains one client's failure instead of ending the run", () => {
    // Without every unsuccessful status here, a single unrenderable invoice
    // fails the iteration, and with a sequential loop that ends the run for
    // every client behind it.
    expect(action("Filter_|_Prepare_Failures").runAfter).toEqual({
      "Scope_|_Prepare_Documents": [
        "Succeeded",
        "Failed",
        "Skipped",
        "TimedOut",
      ],
    });
    expect(action("Filter_|_Prepare_Failures").inputs.from).toBe(
      "@result('Scope_|_Prepare_Documents')",
    );
  });

  it("puts the send strictly downstream of the preparation gate", () => {
    // #102's whole safety rests on this: the email is built and sent inside
    // Condition_|_Prepare_Ok's TRUE branch, so a client with no token or no
    // rendered PDF cannot be emailed at all. Asserted structurally, because a
    // future edit that moved the send one level out would still pass every
    // test about what the message contains.
    const prepared = new Set<string>();
    const walk = (acts: Record<string, any>) => {
      for (const [name, act] of Object.entries<any>(acts ?? {})) {
        prepared.add(name);
        walk(act.actions);
        walk(act.else?.actions);
      }
    };
    walk(action("Condition_|_Prepare_Ok").actions);
    expect(prepared.has("Run_Child_|_Send_Email")).toBe(true);
    expect(prepared.has("Compose_|_Email_Result")).toBe(true);
  });
});

describe("throttling, handled rather than hoped for (#100)", () => {
  it.each([
    ["HTTP_|_Mint_Token", "Mint", "varMintDone"],
    ["Run_Child_|_Generate_PDF", "Pdf", "varPdfDone"],
  ])("retries %s while it is throttled, and only while", (call, slug, variable) => {
    const until = action(`Until_|_${slug}`);
    expect(until.type).toBe("Until");
    expect(until.expression).toBe(`@equals(variables('${variable}'), true)`);
    expect(until.limit.count).toBeGreaterThan(1);
    expect(until.limit.timeout).toBeTruthy();

    // A 429 arrives as a FAILED action. Reading its status is the entire
    // point, so the status compose must run after a failure too.
    expect(action(`Compose_|_${slug}_Status`).runAfter).toEqual({
      [call]: ["Succeeded", "Failed", "TimedOut"],
    });

    const done = (status: number) =>
      evaluate(action(`Set_variable_|_${slug}_Done`).inputs.value, {
        [`outputs('Compose_|_${slug}_Status')`]: status,
      });
    expect(done(429)).toBe(false); // go round again
    expect(done(200)).toBe(true);
    expect(done(500)).toBe(true); // a hard failure is not a throttle
    expect(done(0)).toBe(true); // no response at all is not a throttle
  });

  it("waits for as long as the endpoint asked, not a schedule of its own", () => {
    // Azure documents the retry policy as covering 408/429/5xx but says
    // nothing, anywhere, about honouring Retry-After — so the default policy
    // would retry on its own clock. The mint call therefore carries NO policy.
    expect(action("HTTP_|_Mint_Token").inputs.retryPolicy).toEqual({
      type: "none",
    });

    const wait = (header: string | null) =>
      evaluate(
        action("Delay_|_Mint_Retry_After").inputs.interval.count,
        {
          "outputs('HTTP_|_Mint_Token')?['headers']?['Retry-After']": header,
          "outputs('HTTP_|_Mint_Token')?['headers']?['retry-after']": null,
        },
      );
    expect(wait("90")).toBe(90);
    expect(wait(null)).toBe(30); // the endpoint said nothing
    expect(wait("99999")).toBe(300); // and cannot pin the run open either
    expect(action("Delay_|_Mint_Retry_After").inputs.interval.unit).toBe("Second");
  });

  it("resets its flag per client, which is safe only in a sequential loop", () => {
    // The flags are flow-level variables because Power Automate only allows
    // variables to be initialised at the top level. That is sound only while
    // Apply_to_each_|_Selected runs one repetition at a time.
    expect(
      action("Apply_to_each_|_Selected").runtimeConfiguration.concurrency
        .repetitions,
    ).toBe(1);
    for (const slug of ["Mint", "Pdf"]) {
      expect(action(`Set_variable_|_${slug}_Pending`).inputs.value).toBe(false);
    }
  });
});

/**
 * The volume tripwire (#101).
 *
 * Every other guard in this flow is per-recipient, so none of them can see the
 * three run-level faults that matter: a filter regression that matches ten
 * times the usual population, an upstream change that empties the selection,
 * and a bad-debt creation flow that floods the table overnight. The tests here
 * pin the four properties that make this brake worth having — that it is
 * consulted BEFORE anything is produced, that its baseline cannot be poisoned
 * by the very run it parked, that a park produces nothing at all, and that a
 * human hears about it with the numbers in hand.
 */
describe("the volume tripwire (#101)", () => {
  const topLevel = definition.actions as Record<string, any>;

  /** Does `later` run only once `earlier` has, following runAfter? */
  const runsAfter = (later: string, earlier: string): boolean => {
    const seen = new Set<string>();
    const walk = (name: string): boolean => {
      if (name === earlier) return true;
      if (seen.has(name)) return false;
      seen.add(name);
      return Object.keys(topLevel[name]?.runAfter ?? {}).some(walk);
    };
    return walk(later);
  };

  /** Every action nested anywhere inside the parked branch. */
  const parkedBranch = (() => {
    const found: Array<[string, any]> = [];
    const walk = (actions: Record<string, any>) => {
      for (const [name, act] of Object.entries<any>(actions ?? {})) {
        found.push([name, act]);
        walk(act.actions);
        walk(act.else?.actions);
      }
    };
    walk(action("Condition_|_Tripwire_Tripped").actions);
    return found;
  })();

  /**
   * Runs the two deployed expressions in order — the percentage, then the
   * verdict that reads it — so these cases exercise the WDL that will run in
   * Power Automate rather than a TypeScript restatement of it.
   */
  const judge = ({
    selected,
    previous,
    hasPrevious = true,
    threshold = DEFAULT_VOLUME_THRESHOLD_PERCENT,
    canary = false,
  }: {
    selected: number;
    previous: number;
    hasPrevious?: boolean;
    threshold?: number;
    canary?: boolean;
  }) => {
    const change = evaluate(composeInputs("Compose_|_Volume_Change_Percent"), {
      "outputs('Compose_|_Selected_Count')": selected,
      "outputs('Compose_|_Previous_Count')": previous,
    }) as number;
    const verdict = evaluate(composeInputs("Compose_|_Tripwire_Verdict"), {
      "outputs('Compose_|_Canary_Active')": canary,
      "outputs('Compose_|_Has_Previous_Run')": hasPrevious,
      "outputs('Compose_|_Selected_Count')": selected,
      "outputs('Compose_|_Previous_Count')": previous,
      "outputs('Compose_|_Volume_Change_Percent')": change,
      "outputs('Compose_|_Volume_Threshold_Percent')": threshold,
    }) as string;
    return { change, verdict };
  };

  describe("what it lets through, and what it parks", () => {
    it.each([
      ["an unchanged run", { selected: 40, previous: 40 }, "proceed"],
      ["a 30% rise", { selected: 52, previous: 40 }, "proceed"],
      ["a 25% fall", { selected: 30, previous: 40 }, "proceed"],
      // 56/40 is exactly 40%, which is not MORE than the threshold.
      ["a move to exactly the threshold", { selected: 56, previous: 40 }, "proceed"],
      ["a 42% rise", { selected: 57, previous: 40 }, "volume"],
      ["a 42% fall", { selected: 23, previous: 40 }, "volume"],
      ["a tenfold rise", { selected: 400, previous: 40 }, "volume"],
      ["an emptied selection", { selected: 0, previous: 40 }, "empty"],
    ])("parks %s as '%s'", (_label, counts: any, expected) => {
      expect(judge(counts).verdict).toBe(expected);
    });

    it("proceeds on the first ever run, whatever it selected", () => {
      // No baseline must never mean deadlock: a campaign that cannot start is
      // indistinguishable from one that is broken.
      for (const selected of [0, 5, 4000]) {
        expect(judge({ selected, previous: 0, hasPrevious: false }).verdict).toBe(
          "proceed",
        );
      }
    });

    it("reports an emptied selection as empty rather than as a 100% fall", () => {
      // Both are true; only one of them tells the operator what happened.
      expect(judge({ selected: 0, previous: 40 })).toEqual({
        change: 100,
        verdict: "empty",
      });
    });

    it("proceeds from a zero baseline, which is the gap it cannot close", () => {
      // A previous run that legitimately selected nobody leaves no proportion
      // to measure against, so growth from zero is unguarded. Documented, not
      // fixed: the alternative is parking every restart.
      expect(judge({ selected: 500, previous: 0 }).verdict).toBe("proceed");
    });

    it("measures the move in both directions with no abs()", () => {
      // WDL has no abs(): the documented math set is add, div, max, min, mod,
      // mul, pow, rand, range and sub. max(a-b, b-a) is the absolute
      // difference, and a rise and an equal fall must read the same.
      expect(composeInputs("Compose_|_Volume_Change_Percent")).not.toContain("abs(");
      expect(judge({ selected: 60, previous: 40 }).change).toBe(
        judge({ selected: 20, previous: 40 }).change,
      );
    });

    it("never divides by zero, and does not rely on if() to avoid it", () => {
      // if() takes values, not branches: both arms are evaluated, so a
      // "guarded" div() would still divide. The divisor is max(previous, 1).
      expect(composeInputs("Compose_|_Volume_Change_Percent")).toContain(
        "max(outputs('Compose_|_Previous_Count'), 1)",
      );
      expect(() => judge({ selected: 7, previous: 0 })).not.toThrow();
    });
  });

  describe("the threshold is configuration, not a literal", () => {
    const param = Object.entries<any>(definition.parameters).find(
      ([, p]) => p.metadata?.schemaName === VOLUME_THRESHOLD_VARIABLE,
    )!;

    it("reads the environment variable, under its display name", () => {
      expect(param).toBeDefined();
      expect(composeInputs("Compose_|_Volume_Threshold_Percent")).toContain(
        `parameters('${param[0]}')`,
      );
    });

    it("changes the verdict when the threshold changes", () => {
      // The one assertion that proves the comparison consults the variable
      // rather than a baked-in number.
      const counts = { selected: 48, previous: 40 }; // a 20% move
      expect(judge({ ...counts, threshold: 10 }).verdict).toBe("volume");
      expect(judge({ ...counts, threshold: 40 }).verdict).toBe("proceed");
    });

    it("falls back to the documented default when the variable is unset", () => {
      const read = (value: unknown) =>
        evaluate(composeInputs("Compose_|_Volume_Threshold_Percent"), {
          [`parameters('${param[0]}')`]: value,
        });
      expect(read(null)).toBe(DEFAULT_VOLUME_THRESHOLD_PERCENT);
      expect(read("15")).toBe(15);
      // int() throws on a non-numeric value, which fails the run at this
      // compose — upstream of everything — rather than sending with a
      // threshold nobody meant.
      expect(() => read("forty")).toThrow();
    });
  });

  describe("the baseline cannot be poisoned by the run it parked", () => {
    const previous = action("List_rows_|_Previous_Run").inputs.parameters;

    it("compares only against a run that was acted on", () => {
      // THE safety property. A tenfold selection that set the baseline would
      // park once and then look normal for ever after.
      for (const outcome of BASELINE_OUTCOMES) {
        expect(previous["$filter"]).toContain(`riivo_outcome eq '${outcome}'`);
      }
      expect(previous["$filter"]).not.toContain(RUN_OUTCOME.ABORTED);
    });

    it("reads exactly the latest one", () => {
      expect(previous["$orderby"]).toBe("createdon desc");
      expect(previous["$top"]).toBe(1);
    });

    it("records the outcome the verdict implies", () => {
      const outcome = (verdict: string) =>
        evaluate(
          action("Create_|_Run_Record").inputs.parameters["item/riivo_outcome"],
          { "outputs('Compose_|_Tripwire_Verdict')": verdict },
        );
      expect(outcome("proceed")).toBe(RUN_OUTCOME.PROCEEDED);
      expect(outcome("volume")).toBe(RUN_OUTCOME.ABORTED);
      expect(outcome("empty")).toBe(RUN_OUTCOME.ABORTED);
    });

    it("offers the human the one-field way to bless a real change", () => {
      // Raising the threshold to let one run through is the change that never
      // gets put back; marking that run accepted expires on its own.
      expect(action("Run_Child_|_Volume_Alert").inputs.body.text).toContain(
        RUN_OUTCOME.ACCEPTED,
      );
    });

    it("treats a rehearsal as a baseline, and records which it was", () => {
      // Selection does not read test mode — only the bookkeeping gate does —
      // so a dry run selects exactly what a live run would and is a valid
      // comparison. The column is what lets a human tell them apart later.
      expect(
        action("Create_|_Run_Record").inputs.parameters["item/riivo_testmode"],
      ).toBe("@outputs('Compose_|_TestMode')");
      expect(previous["$filter"]).not.toContain("riivo_testmode");
    });
  });

  describe("a parked run produces nothing", () => {
    it("is consulted before anything is minted, rendered or recorded", () => {
      // Not merely "before any send": the per-client loop mints tokens, writes
      // them back and renders PDFs in BOTH modes, so the gate has to sit in
      // front of the loop, and the only route to any of it is through the loop.
      expect(runsAfter("Apply_to_each_|_Selected", "Condition_|_Tripwire_Tripped")).toBe(
        true,
      );
      for (const costly of [
        "HTTP_|_Mint_Token",
        "Run_Child_|_Generate_PDF",
        "Update_|_Invoice_Token",
        "Update_|_Touch_First",
        "Update_|_Touch_Repeat",
      ]) {
        expect(Object.keys(topLevel), `${costly} is reachable without the gate`)
          .not.toContain(costly);
      }
    });

    it("does nothing in the parked branch but alert and terminate", () => {
      expect(parkedBranch.map(([name]) => name)).toEqual([
        "Run_Child_|_Volume_Alert",
        "Terminate_|_Parked",
      ]);
      for (const [name, act] of parkedBranch) {
        expect(
          act.inputs?.host?.operationId,
          `${name} touches Dataverse on a parked run`,
        ).toBeUndefined();
      }
    });

    it("terminates once, as a failure, and only from here", () => {
      const terminates = actions.filter(([, a]) => a.type === "Terminate");
      expect(terminates.map(([n]) => n)).toEqual(["Terminate_|_Parked"]);
      expect(terminates[0][1].inputs.runStatus).toBe("Failed");
      // Failed rather than Succeeded so the park is red in run history and
      // reaches the platform's own failure notification — a second path to a
      // human if the email does not arrive.
      expect(terminates[0][1].inputs.runError.message).toContain(
        "outputs('Compose_|_Tripwire_Reason')",
      );
    });

    it("terminates even if the alert could not be delivered", () => {
      // The park is the guarantee; the email is a courtesy. An undeliverable
      // courtesy must not leave the run alive to send.
      expect(action("Terminate_|_Parked").runAfter).toEqual({
        "Run_Child_|_Volume_Alert": ["Succeeded", "Failed", "Skipped", "TimedOut"],
      });
    });
  });

  describe("the run history, written whatever the outcome", () => {
    const created = action("Create_|_Run_Record").inputs.parameters;
    const patched = action("Update_|_Run_Record").inputs.parameters;

    it("records the count before the verdict is acted on", () => {
      // Two reasons it is not deferred to the end: a run that dies mid-loop
      // has still selected what it selected, and a parked run is exactly the
      // one whose count a human needs.
      expect(runsAfter("Condition_|_Tripwire_Tripped", "Create_|_Run_Record")).toBe(
        true,
      );
      expect(created["item/riivo_selectedcount"]).toBe(
        "@outputs('Compose_|_Selected_Count')",
      );
    });

    it("keeps the evidence a later reader needs to judge the decision", () => {
      // The threshold is stored because retuning the environment variable
      // afterwards would otherwise make an old decision unreadable.
      for (const field of [
        "item/riivo_previouscount",
        "item/riivo_changepercent",
        "item/riivo_thresholdpercent",
        "item/riivo_abortreason",
      ]) {
        expect(created[field], `${field} is not recorded`).toBeDefined();
      }
    });

    it("patches the after-the-loop counts onto the row it created", () => {
      expect(patched.recordId).toBe(
        `@outputs('Create_|_Run_Record')?['body/${RUN_TABLE_ID}']`,
      );
      expect(Object.keys(patched).filter((k) => k.startsWith("item/"))).toEqual([
        "item/riivo_resolvedcount",
        "item/riivo_heldcount",
        "item/riivo_emailsentcount",
      ]);
    });

    it("names every column it reads and writes on the declared table", () => {
      // The flow addresses columns as strings, so a typo is invisible until a
      // live run fails. These are the names the deploy script creates.
      const declared = new Set(RUN_TABLE_ATTRIBUTES.map((a) => a.logicalName));
      const platform = new Set(["createdon", "statecode", RUN_TABLE_ID]);
      const referenced = new Set<string>();
      for (const [, act] of actions) {
        const params = act.inputs?.parameters ?? {};
        if (params.entityName !== RUN_TABLE_SET) continue;
        for (const key of Object.keys(params)) {
          if (key.startsWith("item/")) referenced.add(key.slice(5));
        }
        for (const field of String(params["$select"] ?? "").split(",")) {
          if (field) referenced.add(field.trim());
        }
        for (const field of String(params["$filter"] ?? "").match(/riivo_\w+/g) ??
          []) {
          referenced.add(field);
        }
        const order = String(params["$orderby"] ?? "").split(" ")[0];
        if (order) referenced.add(order);
      }

      expect(referenced.size).toBeGreaterThan(8);
      for (const field of referenced) {
        expect(
          declared.has(field) || platform.has(field),
          `${field} is not a column on ${RUN_TABLE_SET}`,
        ).toBe(true);
      }
    });
  });

  describe("the alert reaches a human with the numbers", () => {
    const alert = action("Run_Child_|_Volume_Alert");

    it("uses the house failed-flow child rather than sending its own email", () => {
      // 218 of this org's 322 modern flows alert in exactly this shape. The
      // child owns the recipient (riivo_varFlowErrorTeamMail), the sender and
      // the run link — and using it keeps this build's strongest guarantee
      // intact: that the flow creates no email row and performs no SendEmail
      // until #102/#103 deliberately add one.
      expect(alert.type).toBe("Workflow");
      expect(alert.inputs.host.workflowReferenceName).toBe(ALERT_CHILD_FLOW_ID);
      expect(ALERT_CHILD_FLOW_ID).not.toBe(PDF_CHILD_FLOW_ID);
    });

    it("carries the selected count, the previous count and the threshold", () => {
      const reason = evaluate(composeInputs("Compose_|_Tripwire_Reason"), {
        "outputs('Compose_|_Tripwire_Verdict')": "volume",
        "outputs('Compose_|_Selected_Count')": 412,
        "outputs('Compose_|_Previous_Count')": 38,
        "outputs('Compose_|_Volume_Change_Percent')": 984,
        "outputs('Compose_|_Volume_Threshold_Percent')": 40,
      }) as string;
      expect(reason).toContain("412");
      expect(reason).toContain("38");
      expect(reason).toContain("984%");
      expect(reason).toContain("40%");
      expect(alert.inputs.body.text).toContain("outputs('Compose_|_Tripwire_Reason')");
    });

    it("says which client was emptied out, when that is the fault", () => {
      const reason = evaluate(composeInputs("Compose_|_Tripwire_Reason"), {
        "outputs('Compose_|_Tripwire_Verdict')": "empty",
        "outputs('Compose_|_Selected_Count')": 0,
        "outputs('Compose_|_Previous_Count')": 38,
        "outputs('Compose_|_Volume_Change_Percent')": 100,
        "outputs('Compose_|_Volume_Threshold_Percent')": 40,
      }) as string;
      expect(reason).toContain("no clients at all");
      expect(reason).toContain("38");
    });

    it("says nothing at all on a run that proceeded", () => {
      expect(
        evaluate(composeInputs("Compose_|_Tripwire_Reason"), {
          "outputs('Compose_|_Tripwire_Verdict')": "proceed",
          "outputs('Compose_|_Selected_Count')": 40,
          "outputs('Compose_|_Previous_Count')": 40,
          "outputs('Compose_|_Volume_Change_Percent')": 0,
          "outputs('Compose_|_Volume_Threshold_Percent')": 40,
        }),
      ).toBe("");
    });

    it("passes the run identifiers the child needs for a working link", () => {
      expect(alert.inputs.body.text_2).toBe("@workflow().tags.environmentName");
      expect(alert.inputs.body.text_3).toBe("@workflow().name");
      expect(alert.inputs.body.text_4).toBe("@workflow().run.name");
      expect(alert.inputs.body.text_1).toContain("workflow().tags.flowDisplayName");
      expect(alert.inputs.body.text_1).toContain("volume tripwire");
    });

    it("names no client in the alert", () => {
      // The alert is counts only. The population is in the run record and the
      // dry-run report, which are not a channel email address away from a
      // debtor list landing in a Teams channel.
      const body = JSON.stringify(alert.inputs.body);
      expect(body).not.toContain("varSelected");
      expect(body).not.toContain("varTouches");
      expect(body).not.toContain("items(");
    });
  });

  describe("the table the tripwire depends on", () => {
    it("pins its own entity set name rather than trusting pluralisation", () => {
      // The flow addresses the table by this exact string; a surprise
      // ("riivo_baddebtrunses") would only surface in a live run.
      expect(buildRunTableMetadata().EntitySetName).toBe(RUN_TABLE_SET);
      expect(action("List_rows_|_Previous_Run").inputs.parameters.entityName).toBe(
        RUN_TABLE_SET,
      );
    });

    it("derives every logical name from its schema name, as Dataverse does", () => {
      // The cross-check above is only meaningful if these agree.
      for (const attribute of RUN_TABLE_ATTRIBUTES) {
        expect(attribute.logicalName).toBe(attribute.schemaName.toLowerCase());
      }
    });

    it("creates the table with its primary name column and nothing else", () => {
      const meta = buildRunTableMetadata();
      expect(meta.Attributes).toHaveLength(1);
      expect((meta.Attributes[0] as any).IsPrimaryName).toBe(true);
      expect(buildRunTableAttributeMetadata()).toHaveLength(
        RUN_TABLE_ATTRIBUTES.length - 1,
      );
    });

    it("gives the boolean column the option set Dataverse requires", () => {
      const testMode = buildRunTableAttributeMetadata().find(
        (a: any) => a.SchemaName === "riivo_TestMode",
      ) as any;
      expect(testMode["@odata.type"]).toBe(
        "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
      );
      expect(testMode.OptionSet.TrueOption.Value).toBe(1);
      expect(testMode.OptionSet.FalseOption.Value).toBe(0);
    });
  });
});

/**
 * Structural invariants Power Automate enforces at deploy time.
 *
 * These caught nothing when they were written and are here because a mutation
 * survived: re-pointing one `runAfter` produced a definition whose ordering
 * assertions all still passed while the graph had become circular — something
 * Dataverse would have accepted and the Flow service would have rejected, at
 * the cost of a human's deploy attempt. The cheapest place to notice is here.
 */
describe("the email channel (#102)", () => {
  const send = action("Run_Child_|_Send_Email");
  const body = send.inputs.body as Record<string, string>;

  /** The child call's payload, for one client at one touch. */
  const compose = ({
    touch,
    invoice = "INV-42",
    outstanding = 1234.5,
  }: {
    touch: number;
    invoice?: string;
    outstanding?: number;
  }) => {
    const amount = evaluate(composeInputs("Compose_|_Amount"), {
      "items('Apply_to_each_|_Selected')?['outstanding']": outstanding,
    }) as string;
    const env = {
      "outputs('Compose_|_Touch_Number')": touch,
      "items('Apply_to_each_|_Selected')?['invoiceNumber']": invoice,
      "outputs('Compose_|_Amount')": amount,
    };
    return {
      amount,
      subject: evaluate(composeInputs("Compose_|_Email_Subject"), env) as string,
      paragraphs: JSON.parse(
        evaluate(composeInputs("Compose_|_Email_Paragraphs"), env) as string,
      ) as string[],
    };
  };

  it("sends through the house child, in the house pattern", () => {
    // The child creates the Dataverse email row, writes the
    // activitymimeattachment and performs the bound SendEmail — verified
    // against its deployed definition on 2026-09-11, in that order, so the
    // attachment is on the message the client receives. This flow does none
    // of those three things itself, which the block above pins.
    expect(send.type).toBe("Workflow");
    expect(send.inputs.host.workflowReferenceName).toBe(EMAIL_CHILD_FLOW_ID);
    expect(body.variant).toBe("System");
    expect(body.category).toBe("Transactional");
    expect(body.toRecipientEntitySet).toBe("contacts");
  });

  it("uses no Office 365 Outlook connector anywhere in the path", () => {
    // Sending as a Dataverse activity is what keeps the message on the
    // client's timeline and inside TTT's email statistics; the connector
    // bypasses both, which is why the issue names it by name.
    expect(json).not.toMatch(/shared_office365|office365(outlook)?/i);
  });

  it("carries the Pay-now button and the PDF in the SAME call", () => {
    // The issue's stated main risk: that the branded-email child could do one
    // or the other but not both. It does both, and this is the assertion that
    // says so about the call we actually make.
    expect(body.buttonUrl).toBe("@outputs('Compose_|_Payment_Link')?['url']");
    expect(body.attachmentsJson).toBe(
      "@string(createArray(outputs('Compose_|_Email_Attachment')))",
    );
    expect(action("Compose_|_Email_Attachment").inputs).toEqual({
      name: "@outputs('Compose_|_Document')?['fileName']",
      contentBytes: "@outputs('Compose_|_Document')?['base64']",
      contentType: "application/pdf",
    });
  });

  it("never renders a button without a link behind it", () => {
    const label = (url: string) =>
      evaluate(body.buttonLabel, {
        "outputs('Compose_|_Payment_Link')?['url']": url,
      });
    expect(label("https://pay.example/p/tok")).toBe("Pay now");
    expect(label("")).toBe("");
  });

  it("reads the link from the one compose that publishes it", () => {
    // Compose_|_Payment_Link is a swappable point: the URL form is built
    // there and nowhere else, so the day it changes there is one line to edit.
    expect(body.buttonUrl).toContain("Compose_|_Payment_Link");
    expect(json.split("'/p/'")).toHaveLength(2);
  });

  it("regards the invoice, which is what puts it on the timeline", () => {
    expect(body.regardingEntitySet).toBe("new_invoiceses");
    expect(body.regardingId).toBe(
      "@items('Apply_to_each_|_Selected')?['invoiceId']",
    );
  });

  it("greets the client by the name already read at selection", () => {
    // No second GetItem in the send loop: the contact was fetched once when
    // consent was evaluated, and the name travelled on the candidate row.
    expect(body.greetingName).toBe(
      "@items('Apply_to_each_|_Selected')?['firstName']",
    );
    expect(
      JSON.stringify(action("Append_to_array_variable_|_Candidate").inputs),
    ).toContain("firstname");
  });

  it.each([1, 2, 3, 4, 5, 9])(
    "names the invoice and the outstanding amount at touch %i",
    (touch) => {
      const { subject, paragraphs, amount } = compose({ touch });
      expect(amount).toBe("1234.50");
      expect(subject).toContain("INV-42");
      expect(paragraphs[0]).toContain("INV-42");
      expect(paragraphs[0]).toContain("R 1234.50");
    },
  );

  it("takes the amount from ttt_outstanding, never an original total", () => {
    // The candidate row's `outstanding` is populated from ttt_outstanding at
    // selection; this is the line that carries it into the message.
    expect(composeInputs("Compose_|_Amount")).toContain(
      "items('Apply_to_each_|_Selected')?['outstanding']",
    );
    const selection = JSON.stringify(
      action("Append_to_array_variable_|_Candidate").inputs.value,
    );
    expect(selection).toContain("ttt_outstanding");
  });

  it("escalates through the ladder and never wraps back to it", () => {
    // The same failure D12 guards on WhatsApp: a fresh opening message after
    // a final notice. Touch 5 and beyond get the ongoing copy, and it is not
    // touch 1's.
    const at = (touch: number) => compose({ touch }).subject;
    expect(at(1)).toMatch(/^Outstanding account/);
    expect(at(2)).toMatch(/^Reminder/);
    expect(at(3)).toMatch(/^Urgent/);
    expect(at(4)).toMatch(/^Final notice/);
    for (const touch of [5, 6, 40]) {
      expect(at(touch)).toBe(at(5));
      expect(at(touch)).not.toBe(at(1));
    }
  });

  it("attaches the invoice to every rung, by saying so in the copy", () => {
    for (const touch of [1, 2, 3, 4, 5]) {
      const { paragraphs } = compose({ touch });
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[1]).toContain("attached");
      expect(paragraphs[1]).toContain("proof of payment");
    }
  });

  it("serialises its payloads instead of concatenating JSON by hand", () => {
    // c430ace5 builds attachmentsJson by string concatenation, so a quote or
    // a backslash in a generated filename would produce a body the child
    // cannot parse. Letting WDL serialise cannot have that bug — and the
    // assertion is that no hand-built JSON fragment survives anywhere.
    expect(body.paragraphsJson).toBe("@outputs('Compose_|_Email_Paragraphs')");
    expect(composeInputs("Compose_|_Email_Paragraphs")).toContain(
      "string(createArray(",
    );
    expect(json).not.toContain('{\\"name\\":');
    expect(json).not.toContain("contentBytes\\\":\\\"");
  });

  describe("who it will not email", () => {
    const gate = (testMode: boolean, emailAllowed: boolean) =>
      evaluateCondition(action("Condition_|_Send_Email").expression, {
        "outputs('Compose_|_TestMode')": testMode,
        "items('Apply_to_each_|_Selected')?['emailAllowed']": emailAllowed,
      });

    it("sends nothing in test mode, not even redirected to a test address", () => {
      // c430ace5 redirects to riivo_TestRecipient instead. Its population is
      // a handful of invoices; ours is the whole book, and a redirected
      // rehearsal would mail one address several hundred times.
      expect(gate(true, true)).toBe(false);
      expect(json).not.toContain("toEmailOverride");
      expect(json).not.toContain("riivo_TestRecipient");
    });

    it("sends nothing to a client selection already suppressed", () => {
      expect(gate(false, false)).toBe(false);
      expect(gate(false, true)).toBe(true);
    });

    it("treats a row that says nothing about consent as suppressed", () => {
      // coalesce(..., false), not (..., true). Every other default in this
      // build leans towards contactable, copied from c430ace5; this one must
      // not, because it is not a consent flag — it is the ANSWER this run
      // already computed from three of them, and a missing answer means the
      // question was never asked.
      expect(gate(false, null as unknown as boolean)).toBe(false);
      expect(
        JSON.stringify(action("Condition_|_Send_Email").expression),
      ).toContain("emailAllowed'], false)");
    });

    it("is reached only by a client the preparation gate cleared", () => {
      // The send lives in Condition_|_Prepare_Ok's true branch, so the
      // no-message-without-its-attachment guarantee covers email by
      // construction. This asserts the branch actually reads that verdict —
      // structure alone would still be satisfied by a condition on `true`.
      const prepared = (ok: boolean) =>
        evaluateCondition(action("Condition_|_Prepare_Ok").expression, {
          "outputs('Compose_|_Prepare_Ok')": ok,
        });
      expect(prepared(true)).toBe(true);
      expect(prepared(false)).toBe(false);
    });

    it("leaves a second consent check to the child, against fresher data", () => {
      // Our gate reads the contact at selection; the child re-reads it at
      // send time and refuses on donotemail or a recorded bounce. Both
      // layers exist deliberately — this asserts ours, and that we do not
      // pass anything that would bypass theirs.
      expect(composeInputs("Compose_|_Email_Allowed")).toContain("donotemail");
      expect(composeInputs("Compose_|_Email_Allowed")).toContain(
        "donotbulkemail",
      );
      expect(body.category).toBe("Transactional");
    });
  });

  describe("what it records afterwards", () => {
    const result = ({
      testMode = false,
      emailAllowed = true,
      sent = null as boolean | null,
      skipped = null as boolean | null,
      skipReason = null as string | null,
      emailId = null as string | null,
    }) =>
      evaluate(action("Compose_|_Email_Result").inputs.note, {
        "outputs('Compose_|_TestMode')": testMode,
        "items('Apply_to_each_|_Selected')?['emailAllowed']": emailAllowed,
        "body('Run_Child_|_Send_Email')?['sent']": sent,
        "body('Run_Child_|_Send_Email')?['skipped']": skipped,
        "body('Run_Child_|_Send_Email')?['skipReason']": skipReason,
        "body('Run_Child_|_Send_Email')?['emailId']": emailId,
      }) as string;

    it("advances a counter only where the CHILD reported a send", () => {
      // Not "we called it" and not "a row was created": the child reports
      // false when the org switch left the mail as a draft and when it
      // refused the recipient, and those must advance nothing.
      expect(action("Compose_|_Send_Outcome").inputs.email).toBe(
        "@outputs('Compose_|_Email_Result')?['sent']",
      );
      expect(action("Compose_|_Email_Result").inputs.sent).toBe(
        "@equals(coalesce(body('Run_Child_|_Send_Email')?['sent'], false), true)",
      );
      expect(composeInputs("Compose_|_Touch_Sent")).toContain(
        "outputs('Compose_|_Send_Outcome')",
      );
    });

    it("still refuses to record a touch in test mode", () => {
      expect(composeInputs("Compose_|_Touch_Sent")).toContain(
        "not(outputs('Compose_|_TestMode'))",
      );
    });

    it("says why, whenever a resolved client was not emailed", () => {
      // The same rule the held rows follow: a silent client is never a
      // silent failure. Each of these is a different silence.
      expect(result({ testMode: true })).toMatch(/test mode/);
      expect(result({ emailAllowed: false })).toMatch(/suppressed/);
      expect(result({ sent: true, emailId: "abc" })).toBe("");
      expect(
        result({ sent: false, skipped: true, skipReason: "Do Not Allow Email" }),
      ).toBe("Do Not Allow Email");
      expect(result({ sent: false })).toMatch(/did not answer/);
      // The one that matters most during a rehearsal: everything worked and
      // the org switch is off, so there is a draft rather than a send.
      expect(result({ sent: false, skipped: false, emailId: "abc" })).toMatch(
        /riivo_SendEmail is off/,
      );
    });

    it("reads every child answer null-safely, because a failed call has none", () => {
      const inputs = JSON.stringify(action("Compose_|_Email_Result").inputs);
      for (const field of ["sent", "skipped", "skipReason", "emailId"]) {
        expect(inputs).toContain(`?['${field}']`);
      }
      expect(inputs).not.toMatch(/body\('Run_Child_\|_Send_Email'\)\['/);
    });

    it("carries the outcome onto the touch row and into the run history", () => {
      const touch = JSON.stringify(
        action("Append_to_array_variable_|_Touch").inputs.value,
      );
      expect(touch).toContain("emailSent");
      expect(touch).toContain("emailNote");
      expect(action("Filter_|_Emails_Sent").inputs).toEqual({
        from: "@variables('varTouches')",
        where: "@equals(item()['emailSent'], true)",
      });
      expect(
        action("Update_|_Run_Record").inputs.parameters[
          "item/riivo_emailsentcount"
        ],
      ).toBe("@length(body('Filter_|_Emails_Sent'))");
    });

    it("says whether the org switch was even on", () => {
      // Without this the first rehearsal — which correctly produces drafts —
      // is indistinguishable from one that silently failed to send.
      expect(
        JSON.stringify(composeInputs("Compose_|_Dry_Run_Report")),
      ).toContain("riivo_SendEmail");
    });
  });

  it("contains a failed send instead of ending the run", () => {
    // Same property #100 established for the preparation scope: one client's
    // failure is theirs. Reading the result on Failed is what handles it.
    expect(action("Compose_|_Email_Result").runAfter).toEqual({
      "Condition_|_Send_Email": ["Succeeded", "Failed", "Skipped", "TimedOut"],
    });
  });

  it("leaves an unsent client's bookkeeping exactly as it was", () => {
    // Which is what makes "the next run picks them up again" true: no touch,
    // no riivo_campaignlastsent, so the cadence guard does not exclude them.
    const patches = actions.filter(
      ([, a]) =>
        a.inputs?.parameters?.entityName === "riivo_baddebts" &&
        a.inputs?.host?.operationId === "UpdateRecord",
    );
    expect(patches.map(([n]) => n).sort()).toEqual([
      "Update_|_Touch_First",
      "Update_|_Touch_Repeat",
    ]);
    const branch = JSON.stringify(action("Condition_|_Touch_Sent").actions);
    expect(branch).toContain("Update_|_Touch_First");
    expect(JSON.stringify(action("Condition_|_Touch_Sent").else)).toBe(
      '{"actions":{}}',
    );
  });
});

describe("the canary list (#102)", () => {
  const topLevel = definition.actions as Record<string, any>;

  const filterFor = (ids: string[]) => {
    const clause = ids.map((id) => `_riivo_client_value eq ${id}`);
    return evaluate(composeInputs("Compose_|_Canary_Filter"), {
      "outputs('Compose_|_Canary_Active')": ids.length > 0,
      "body('Select_|_Canary_Clauses')": clause,
    }) as string;
  };

  it("restricts the QUERY, so an unlisted client is never even fetched", () => {
    // Same principle as the cadence guard: a record that is out of scope is
    // not fetched, so no later branch can act on it by accident — and no
    // token is minted and no PDF rendered for anyone off the list.
    expect(topLevel["List_rows_|_Open_BadDebts"].inputs.parameters.$filter)
      .toContain("outputs('Compose_|_Canary_Filter')");
    expect(filterFor(["a-1", "b-2"])).toBe(
      " and (_riivo_client_value eq a-1 or _riivo_client_value eq b-2)",
    );
  });

  it("means the whole book when it is empty, which is the normal state", () => {
    expect(filterFor([])).toBe("");
    const parameter = (definition.parameters as any)[
      `Bad Debt Canary Contact Ids (${CANARY_VARIABLE})`
    ];
    expect(parameter.defaultValue).toBe("");
  });

  it("fails the run rather than falling back to everybody", () => {
    // json() on a malformed value throws, which ends the run during
    // selection. The alternative — treating an unparseable allowlist as "no
    // restriction" — turns a typo into an unintended mass send.
    const ids = composeInputs("Compose_|_Canary_Ids");
    expect(ids).toContain(`json(trim(parameters('Bad Debt Canary Contact Ids (${CANARY_VARIABLE})')))`);
    expect(ids).not.toContain("try");
  });

  it("skips the volume tripwire, which could only ever park it", () => {
    // A restricted run is anomalous by construction: three of six hundred is
    // a 99% fall. The canary case short-circuits every volume test.
    const verdict = evaluate(composeInputs("Compose_|_Tripwire_Verdict"), {
      "outputs('Compose_|_Canary_Active')": true,
      "outputs('Compose_|_Has_Previous_Run')": true,
      "outputs('Compose_|_Selected_Count')": 3,
      "outputs('Compose_|_Previous_Count')": 600,
      "outputs('Compose_|_Volume_Change_Percent')": 99,
      "outputs('Compose_|_Volume_Threshold_Percent')": 40,
    });
    expect(verdict).toBe("canary");
  });

  it("runs the loop rather than parking, unlike every other non-proceed verdict", () => {
    const parked = (verdict: string) =>
      evaluateCondition(action("Condition_|_Tripwire_Tripped").expression, {
        "outputs('Compose_|_Tripwire_Verdict')": verdict,
      });
    expect(parked("proceed")).toBe(false);
    expect(parked("canary")).toBe(false);
    expect(parked("volume")).toBe(true);
    expect(parked("empty")).toBe(true);
  });

  it("can never become the next run's baseline", () => {
    // The mirror of the aborted-run rule, from the other direction: let a
    // canary set the baseline and the next unrestricted run looks like a
    // twentyfold explosion and parks — the tripwire firing on the return to
    // normal rather than on the anomaly.
    expect(BASELINE_OUTCOMES).not.toContain(RUN_OUTCOME.CANARY);
    const outcome = evaluate(
      action("Create_|_Run_Record").inputs.parameters["item/riivo_outcome"],
      { "outputs('Compose_|_Tripwire_Verdict')": "canary" },
    );
    expect(outcome).toBe(RUN_OUTCOME.CANARY);
  });

  it("records how many clients it was restricted to", () => {
    expect(
      action("Create_|_Run_Record").inputs.parameters["item/riivo_canarycount"],
    ).toBe("@length(outputs('Compose_|_Canary_Ids'))");
    expect(RUN_TABLE_ATTRIBUTES.map((a) => a.logicalName)).toContain(
      "riivo_canarycount",
    );
  });

  it("leaves abortreason empty, because nothing was aborted", () => {
    const reason = evaluate(composeInputs("Compose_|_Tripwire_Reason"), {
      "outputs('Compose_|_Tripwire_Verdict')": "canary",
      "outputs('Compose_|_Selected_Count')": 3,
      "outputs('Compose_|_Previous_Count')": 600,
      "outputs('Compose_|_Volume_Change_Percent')": 99,
      "outputs('Compose_|_Volume_Threshold_Percent')": 40,
    });
    expect(reason).toBe("");
  });

  it("nags a human on every restricted run, and does not terminate", () => {
    // The failure mode of an allowlist is not that it is set — that is
    // deliberate — it is that it is LEFT set, turning a campaign into a
    // private conversation with three people that shows up nowhere.
    const branch = action("Condition_|_Canary_Run").actions;
    expect(Object.keys(branch)).toEqual([
      "Run_Child_|_Canary_Alert",
      "Compose_|_Canary_Alert_Status",
    ]);
    expect(branch["Run_Child_|_Canary_Alert"].inputs.host.workflowReferenceName)
      .toBe(ALERT_CHILD_FLOW_ID);
    expect(JSON.stringify(branch)).not.toContain("Terminate");
    expect(JSON.stringify(branch)).toContain(CANARY_VARIABLE);
  });

  it("cannot be failed by its own undeliverable notice", () => {
    const branch = action("Condition_|_Canary_Run").actions;
    expect(branch["Compose_|_Canary_Alert_Status"].runAfter).toEqual({
      "Run_Child_|_Canary_Alert": [
        "Succeeded",
        "Failed",
        "Skipped",
        "TimedOut",
      ],
    });
    expect(topLevel["Initialize_variable_|_Touches"].runAfter).toEqual({
      "Condition_|_Canary_Run": ["Succeeded"],
    });
  });

  it("names no client in the notice it sends the team", () => {
    // The same rule #101's park alert follows: an alert is an operational
    // message on a channel with a wider audience than the campaign has.
    const alert = JSON.stringify(
      action("Run_Child_|_Canary_Alert").inputs.body,
    );
    expect(alert).not.toMatch(/clientId|invoiceNumber|emailaddress/);
    expect(alert).toContain("length(outputs('Compose_|_Canary_Ids'))");
  });
});

describe("the definition is structurally deployable", () => {
  /** Every scope's own action map: the top level, and each nested branch. */
  const containers = (() => {
    const found: Array<[string, Record<string, any>]> = [];
    const walk = (path: string, map: Record<string, any>) => {
      if (!map) return;
      found.push([path, map]);
      for (const [name, act] of Object.entries<any>(map)) {
        walk(`${path}/${name}`, act.actions);
        walk(`${path}/${name}:else`, act.else?.actions);
      }
    };
    walk("", definition.actions);
    return found;
  })();

  it("orders every action against siblings that exist in its own scope", () => {
    // runAfter is scoped: naming an action from an enclosing scope is not a
    // dependency, it is a definition the service refuses.
    for (const [path, map] of containers) {
      const siblings = new Set(Object.keys(map));
      for (const [name, act] of Object.entries<any>(map)) {
        for (const dependency of Object.keys(act.runAfter ?? {})) {
          expect(
            siblings.has(dependency),
            `${path}/${name} runs after ${dependency}, which is not in its scope`,
          ).toBe(true);
        }
      }
    }
  });

  it("has no circular ordering anywhere", () => {
    for (const [path, map] of containers) {
      const state = new Map<string, "open" | "done">();
      const visit = (name: string, trail: string[]) => {
        if (state.get(name) === "done") return;
        expect(
          state.get(name),
          `cycle in ${path}: ${[...trail, name].join(" -> ")}`,
        ).not.toBe("open");
        state.set(name, "open");
        for (const dependency of Object.keys(map[name]?.runAfter ?? {})) {
          visit(dependency, [...trail, name]);
        }
        state.set(name, "done");
      };
      for (const name of Object.keys(map)) visit(name, []);
    }
  });

  it("starts each scope from exactly one action", () => {
    // Every scope here is written as a strict sequence, so a second action
    // with an empty runAfter is not a parallel branch anyone intended — it is
    // an action somebody forgot to thread, running immediately and reading
    // outputs that do not exist yet. Empty else-branches have no root at all.
    for (const [path, map] of containers) {
      const roots = Object.entries<any>(map)
        .filter(([, act]) => Object.keys(act.runAfter ?? {}).length === 0)
        .map(([name]) => name);
      expect(roots, `${path || "(top level)"} starts from ${roots.length}`)
        .toHaveLength(Object.keys(map).length === 0 ? 0 : 1);
    }
  });
});
