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
 */
import { describe, it, expect } from "vitest";
import {
  buildBadDebtRecoveryTouchesFlow,
  FLOW_NAME,
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

  it("writes nothing back to Dataverse — selection only", () => {
    for (const [name, action] of actions) {
      const op = action.inputs?.host?.operationId;
      expect(
        ["CreateRecord", "UpdateRecord", "DeleteRecord"].includes(op),
        `${name} mutates Dataverse (${op})`,
      ).toBe(false);
    }
  });

  it("records no touch bookkeeping — that is issue #99, not this slice", () => {
    expect(json).not.toMatch(/riivo_campaignsendcount|riivo_campaignfirstsent/);
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
