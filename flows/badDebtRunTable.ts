/**
 * `riivo_baddebtrun` — one row per bad-debt recovery run, issue #101.
 *
 * WHY A TABLE AND NOT SOMETHING CHEAPER
 * The volume tripwire compares this run's selected count against the previous
 * run's, so the previous count has to survive between runs. Three cheaper
 * stores were considered and rejected:
 *
 *  - **An environment variable the flow writes back.** Environment variable
 *    *values* are solution-aware rows: a solution import overwrites them, so
 *    the prod promotion this build is heading for would silently reset the
 *    baseline. Config is also the wrong shape for state that changes twice a
 *    week.
 *  - **Recomputing it from `riivo_baddebt` bookkeeping** (count the rows whose
 *    `riivo_campaignlastsent` falls on the previous run's date). That records
 *    what was *sent*, not what was *selected* — held clients would drift the
 *    baseline down and make the next run look like growth — and it records
 *    nothing at all for a run that aborted, which is precisely the run whose
 *    count #101 asks us to keep.
 *  - **`riivo_systemsettings`** (name + integer, already exists). No field for
 *    the outcome, so the one property that makes this tripwire safe — an
 *    aborted run must never become the next run's baseline — could only be
 *    encoded in the name string.
 *
 * `riivo_systemevent` was the other existing candidate; its `riivo_eventtype`
 * is application-required with exactly one option, "Document Decryption".
 *
 * WHY IT IS DECLARED HERE
 * The flow addresses these columns as strings (`item/riivo_selectedcount`), so
 * a typo is invisible until a live run fails. Declaring the table in code lets
 * `__tests__/badDebtRecoveryTouches.test.ts` check every column the flow reads
 * or writes against this list, and lets the deploy script create the table from
 * the same source. The metadata POST itself is a human step (an agent cannot
 * write to Dataverse), so the names are the part worth pinning.
 */

/** Entity set name — what the Dataverse connector's `entityName` takes. */
export const RUN_TABLE_SET = "riivo_baddebtruns";
export const RUN_TABLE_LOGICAL = "riivo_baddebtrun";
export const RUN_TABLE_SCHEMA = "riivo_BadDebtRun";
export const RUN_TABLE_ID = "riivo_baddebtrunid";

/**
 * The outcome vocabulary, and the whole safety property of the tripwire.
 *
 * `PROCEEDED` and `ACCEPTED` are baselines; `ABORTED` is not. An aborted run
 * that set the baseline would disarm the tripwire on the very next run — a
 * selection that jumped tenfold would abort once, record ten times the usual
 * count, and then look perfectly normal. So the previous-count query reads
 * only runs that were acted on, and a population that stays anomalous keeps
 * parking until a human intervenes.
 *
 * `ACCEPTED` is that intervention, and it is a one-field edit rather than a
 * config change: a human who has looked at a parked run and decided the new
 * volume is real sets its outcome to `accepted`, and the next run compares
 * against it. The alternative — retuning the threshold to let one run through
 * and remembering to put it back — is the kind of temporary change that
 * becomes permanent.
 */
export const RUN_OUTCOME = {
  PROCEEDED: "proceeded",
  ABORTED: "aborted",
  ACCEPTED: "accepted",
  CANARY: "canary",
} as const;

/**
 * Outcomes a later run is allowed to compare itself against.
 *
 * `CANARY` (#102) is excluded for the same reason `ABORTED` is, from the other
 * direction. A canary run is restricted by hand to a named handful of clients,
 * so its count is small BY CONSTRUCTION. Let it become the baseline and the
 * next unrestricted run looks like a twentyfold explosion and parks — the
 * tripwire firing on the return to normal rather than on the anomaly.
 */
export const BASELINE_OUTCOMES: string[] = [
  RUN_OUTCOME.PROCEEDED,
  RUN_OUTCOME.ACCEPTED,
];

type Attribute = {
  schemaName: string;
  logicalName: string;
  kind: "String" | "Integer" | "Boolean";
  description: string;
  maxLength?: number;
  isPrimaryName?: boolean;
};

/**
 * Every column the flow touches. `riivo_resolvedcount` and `riivo_heldcount`
 * are written by a second patch after the per-client loop, so they are null on
 * an aborted run — which is the truth about it: it resolved and held nothing.
 */
export const RUN_TABLE_ATTRIBUTES: Attribute[] = [
  {
    schemaName: "riivo_Name",
    logicalName: "riivo_name",
    kind: "String",
    maxLength: 200,
    isPrimaryName: true,
    description: "The run, named by the UTC instant it started.",
  },
  {
    schemaName: "riivo_SelectedCount",
    logicalName: "riivo_selectedcount",
    kind: "Integer",
    description:
      "Clients selected by this run, one per client, after the collapse to the newest in-scope invoice. The number the tripwire compares and the next run's baseline.",
  },
  {
    schemaName: "riivo_PreviousCount",
    logicalName: "riivo_previouscount",
    kind: "Integer",
    description:
      "The selected count this run was compared against — the most recent earlier run whose outcome was proceeded or accepted. 0 when there was none.",
  },
  {
    schemaName: "riivo_ChangePercent",
    logicalName: "riivo_changepercent",
    kind: "Integer",
    description:
      "Absolute movement from the previous count, as a whole-number percentage, truncated. Stored so a parked run explains itself without recomputation.",
  },
  {
    schemaName: "riivo_ThresholdPercent",
    logicalName: "riivo_thresholdpercent",
    kind: "Integer",
    description:
      "The threshold in force when this run was judged. Stored because retuning the environment variable afterwards would otherwise make an old decision unreadable.",
  },
  {
    schemaName: "riivo_Outcome",
    logicalName: "riivo_outcome",
    kind: "String",
    maxLength: 20,
    description:
      "proceeded | aborted | accepted | canary. Only proceeded and accepted runs are baselines for a later run, so neither an anomalous selection (by aborting once) nor a deliberately restricted canary (by selecting three people) can disarm the tripwire. Set aborted -> accepted by hand to bless a genuinely larger population.",
  },
  {
    schemaName: "riivo_AbortReason",
    logicalName: "riivo_abortreason",
    kind: "String",
    maxLength: 400,
    description:
      "Why the run was parked, in the same words the alert email carries. Empty on a run that proceeded.",
  },
  {
    schemaName: "riivo_TestMode",
    logicalName: "riivo_testmode",
    kind: "Boolean",
    description:
      "riivo_ReminderTestMode as this run read it. Selection does not depend on it, so a rehearsal is a valid baseline for a live run — this column is what lets a human tell them apart afterwards.",
  },
  {
    schemaName: "riivo_CanaryCount",
    logicalName: "riivo_canarycount",
    kind: "Integer",
    description:
      "How many clients riivo_BadDebtCanaryContactIds named when this run read it; 0 on an unrestricted run (#102). Recorded on the row because the variable is edited between runs, so a month later it is the only way to tell a small run that was deliberately restricted from a small run that was all there was.",
  },
  {
    schemaName: "riivo_EmailSentCount",
    logicalName: "riivo_emailsentcount",
    kind: "Integer",
    description:
      "Clients this run actually emailed — the branded-email child reported the send, not merely that a draft was created (#102). Written with the after-the-loop counts, so null on a parked run. The figure the campaign is measured by: resolved says ready, this says delivered to the mail system.",
  },
  {
    schemaName: "riivo_WhatsAppSentCount",
    logicalName: "riivo_whatsappsentcount",
    kind: "Integer",
    description:
      "Clients this run actually reached on WhatsApp — Meta accepted the template send and returned a message id (#103). Written with the after-the-loop counts, so null on a parked run. Kept beside riivo_emailsentcount rather than summed with it: the two channels fail for different reasons, and a run where WhatsApp collapsed while email held up is invisible in a single total.",
  },
  {
    schemaName: "riivo_ResolvedCount",
    logicalName: "riivo_resolvedcount",
    kind: "Integer",
    description:
      "Clients that left the run with a template, a token and a PDF. Written after the per-client loop, so null on a parked run.",
  },
  {
    schemaName: "riivo_HeldCount",
    logicalName: "riivo_heldcount",
    kind: "Integer",
    description:
      "Clients the run deliberately said nothing to, each with a reason in the dry-run report. Written after the per-client loop, so null on a parked run.",
  },
];

const label = (text: string) => ({
  "@odata.type": "Microsoft.Dynamics.CRM.Label",
  LocalizedLabels: [
    {
      "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
      Label: text,
      LanguageCode: 1033,
    },
  ],
});

const requiredLevel = (value: "None" | "ApplicationRequired") => ({
  Value: value,
  CanBeChanged: true,
  ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings",
});

/** One attribute as its `EntityDefinitions(...)/Attributes` POST body. */
export function buildAttributeMetadata(attribute: Attribute) {
  const common = {
    SchemaName: attribute.schemaName,
    DisplayName: label(
      attribute.schemaName.replace(/^riivo_/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
    ),
    Description: label(attribute.description),
    RequiredLevel: requiredLevel(
      attribute.isPrimaryName ? "ApplicationRequired" : "None",
    ),
  };

  if (attribute.kind === "String") {
    return {
      "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
      ...common,
      MaxLength: attribute.maxLength,
      FormatName: { Value: "Text" },
      ...(attribute.isPrimaryName ? { IsPrimaryName: true } : {}),
    };
  }

  if (attribute.kind === "Integer") {
    return {
      "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
      ...common,
      // A change percentage is unbounded in practice — a jump from 3 clients
      // to 3000 is 99900% — so the ceiling is the type's, not a guess.
      MinValue: 0,
      MaxValue: 2147483647,
      Format: "None",
    };
  }

  return {
    "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
    ...common,
    DefaultValue: false,
    OptionSet: {
      "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
      TrueOption: {
        "@odata.type": "Microsoft.Dynamics.CRM.OptionMetadata",
        Value: 1,
        Label: label("Yes"),
      },
      FalseOption: {
        "@odata.type": "Microsoft.Dynamics.CRM.OptionMetadata",
        Value: 0,
        Label: label("No"),
      },
    },
  };
}

/**
 * The table's own POST body, carrying only the primary name column.
 *
 * `EntitySetName` is set explicitly rather than left to the platform's
 * pluralisation, because the flow addresses the table by that exact string and
 * a surprise ("riivo_baddebtrunses") would only surface at runtime.
 *
 * OrganizationOwned: a run is a fact about the org, not a record anyone owns,
 * and org-owned avoids per-user read scoping on a table every run must read —
 * which matters for the least-privilege prod service principal (R7).
 */
export function buildRunTableMetadata() {
  const primary = RUN_TABLE_ATTRIBUTES.find((a) => a.isPrimaryName)!;
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
    SchemaName: RUN_TABLE_SCHEMA,
    EntitySetName: RUN_TABLE_SET,
    DisplayName: label("Bad Debt Run"),
    DisplayCollectionName: label("Bad Debt Runs"),
    Description: label(
      "One row per run of 'Invoice - Scheduled - Send Bad Debt Recovery Touches' (#101). Records what the run selected, what it was compared against, and whether it proceeded or was parked by the volume tripwire. Written on every run, including a run that aborted and a run in test mode.",
    ),
    OwnershipType: "OrganizationOwned",
    IsActivity: false,
    HasNotes: false,
    HasActivities: false,
    Attributes: [buildAttributeMetadata(primary)],
  };
}

/** The attributes added after the table exists, in declaration order. */
export function buildRunTableAttributeMetadata() {
  return RUN_TABLE_ATTRIBUTES.filter((a) => !a.isPrimaryName).map(
    buildAttributeMetadata,
  );
}
