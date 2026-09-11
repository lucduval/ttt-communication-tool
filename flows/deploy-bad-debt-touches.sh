#!/usr/bin/env bash
#
# Deploys `Invoice - Scheduled - Send Bad Debt Recovery Touches` (issues #98 to
# #102) into the TTT **dev** org, with the environment variables and the
# riivo_baddebtrun table it depends on. Creates the flow as a DRAFT (off) — per
# D9, no agent and no script activates anything; Luc promotes dev -> prod by hand.
#
# Idempotent: re-running skips anything that already exists, column by column
# as well as wholesale, so a run that died halfway can simply be repeated.
#
#   bash flows/deploy-bad-debt-touches.sh            # deploy
#   bash flows/deploy-bad-debt-touches.sh --check    # report only, write nothing
#   bash flows/deploy-bad-debt-touches.sh --replace  # re-deploy a changed definition
#
# UPDATING AN EXISTING FLOW IS A REPLACE, NOT A PATCH.
# `clientdata` cannot be PATCHed by the service principal — Dataverse answers
# ConnectionAuthorizationFailed because the SP does not own the connection. The
# only route is POST the new definition, verify it, then DELETE the old row,
# which mints a NEW workflowid. That is destructive, so it needs --replace
# rather than happening as a side effect of a plain re-run. The script refuses
# to replace a flow that is switched on: turning one on is a human act, and
# deleting a running flow is not this script's decision to make.
#
set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/ttt-automations-update/.env}"
DYN_URL="https://tttdevelopment.crm4.dynamics.com"
SOLUTION_FLOWS="6Automations"
SOLUTION_VARS="4Variables"
SOLUTION_TABLES="2Tables"
CHECK_ONLY=false
REPLACE=false
case "${1:-}" in
  --check)   CHECK_ONLY=true ;;
  --replace) REPLACE=true ;;
  "")        ;;
  *)         echo "usage: $0 [--check|--replace]" >&2; exit 2 ;;
esac

[[ -f "$ENV_FILE" ]] || { echo "no creds at $ENV_FILE" >&2; exit 1; }
# .env holds multi-line HTML values, so `source` breaks — grep each var.
TENANT=$(grep -m1 '^DYNAMICS_TENANT_ID=' "$ENV_FILE" | cut -d= -f2-)
CID=$(grep -m1 '^DYNAMICS_CLIENT_ID=' "$ENV_FILE" | cut -d= -f2-)
SECRET=$(grep -m1 '^DYNAMICS_CLIENT_SECRET=' "$ENV_FILE" | cut -d= -f2-)

echo "==> authenticating against dev"
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
  -d "grant_type=client_credentials&client_id=$CID&client_secret=$SECRET&scope=${DYN_URL}/.default" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
WHO=$(curl -s "$DYN_URL/api/data/v9.2/WhoAmI" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['UserId'])")
echo "    service principal: $WHO"
[[ "$WHO" == "7229f676-afd5-f011-8544-000d3adca789" ]] \
  || echo "    WARNING: not the documented dev SP — check you are pointed at dev"

api() { # api METHOD PATH [BODY] [EXTRA_HEADER]
  local method="$1" path="$2" body="${3:-}" extra="${4:-}"
  local args=(-s -w '\n%{http_code}' -X "$method" "$DYN_URL/api/data/v9.2/$path"
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/json"
    -H "Content-Type: application/json"
    -H "OData-MaxVersion: 4.0" -H "OData-Version: 4.0")
  [[ -n "$extra" ]] && args+=(-H "$extra")
  [[ -n "$body"  ]] && args+=(-d "$body")
  curl "${args[@]}"
}

# --------------------------------------------------------------- env vars ----
# The two variables this build owns and creates. Everything else it reads
# (payment link, test mode, the flow-error channel) belongs to another build and
# is only checked for below. Both are typed String, following every other
# numeric variable in this org, and read through int().
ensure_env_var() { # ensure_env_var SCHEMANAME DISPLAYNAME DEFAULT DESCRIPTION
  local schema="$1" display="$2" default="$3" description="$4"
  echo "==> environment variable $schema"
  local existing
  existing=$(api GET "environmentvariabledefinitions?\$select=schemaname&\$filter=schemaname%20eq%20'$schema'" \
    | sed '$d' | python3 -c "import sys,json;print(len(json.load(sys.stdin)['value']))")
  if [[ "$existing" != "0" ]]; then
    echo "    already exists — skipping"; return
  fi
  if $CHECK_ONLY; then echo "    MISSING (would create)"; return; fi
  local body
  body=$(python3 - "$schema" "$display" "$default" "$description" <<'PY'
import json, sys
print(json.dumps({
    "schemaname": sys.argv[1],
    "displayname": sys.argv[2],
    "type": 100000000,  # String
    "defaultvalue": sys.argv[3],
    "description": sys.argv[4],
}))
PY
)
  local resp code
  resp=$(api POST "environmentvariabledefinitions" "$body" "MSCRM.SolutionUniqueName: $SOLUTION_VARS")
  code=$(tail -n1 <<<"$resp")
  if [[ "$code" =~ ^2 ]]; then
    echo "    created (HTTP $code)"
  else
    echo "    FAILED (HTTP $code): $(sed '$d' <<<"$resp" | head -c 400)"; exit 1
  fi
}

ensure_env_var riivo_BadDebtMinDaysBetweenTouches \
  "Bad Debt Min Days Between Touches" "2" \
  "Minimum whole days between two bad-debt recovery touches to the same riivo_baddebt record. Guards the Monday/Thursday cadence against a same-day re-run or a Power Automate retry, which would otherwise double-send: Power Automate has no transactions, so this recency test is the only duplicate defence. Default 2 blocks same-day and next-day repeats while leaving the 3-day Mon->Thu gap intact."

ensure_env_var riivo_BadDebtVolumeChangeThresholdPercent \
  "Bad Debt Volume Change Threshold Percent" "40" \
  "How far the selected client count may move from the last acted-on run before the run parks itself and sends nothing, as a whole-number percentage in either direction (#101). 40 is the figure R5 of the spec recommends. Raise it to accept a permanently larger book; to let one parked run through, set that run's riivo_outcome to 'accepted' on its riivo_baddebtrun row instead, which leaves no loosened threshold behind."

# Created EMPTY, which is the safe state: an empty list means the whole book,
# and the run only narrows itself once a human deliberately puts ids in it.
ensure_env_var riivo_BadDebtCanaryContactIds \
  "Bad Debt Canary Contact Ids" "" \
  "A JSON array of contact ids, e.g. [\"26372e5b-40db-f011-8543-7ced8d7556e1\"]. While it is non-empty the bad-debt recovery run speaks ONLY to those clients: the list narrows the selection query itself, so nobody else is fetched, minted for or rendered for (#102). Empty - the normal state - means the whole book. Used to rehearse the email channel on colleagues, then to canary a handful of real clients before the channel is trusted. A restricted run skips the volume tripwire, is recorded as outcome 'canary' so it can never become a later run's baseline, and emails the team every time it runs. CLEAR IT WHEN THE CANARY IS DONE: until it is empty, the campaign is only speaking to those clients."

# ---------------------------------------------------- #100/#101 depend on ----
# The flow reads five environment variables it does NOT create and calls two
# child flows it does not own. A missing dependency is not a deploy-time error —
# Dataverse accepts the definition happily — it is a runtime failure, so it is
# checked here instead.
echo "==> dependencies for the mint and PDF steps (#100) and the tripwire (#101)"
MISSING=0
for DEP in riivo_PaymentLink_BaseUrl riivo_PaymentLink_FunctionKey riivo_PaymentLinkEnabled \
           riivo_EnvironmentAddress riivo_varFlowErrorTeamMail \
           riivo_SharedSenderUserId riivo_SendEmail \
           riivo_varMetaURI riivo_varMetaUploadURI riivo_varMetaAccessToken; do
  COUNT=$(api GET "environmentvariabledefinitions?\$select=schemaname&\$filter=schemaname%20eq%20'$DEP'" \
    | sed '$d' | python3 -c "import sys,json;print(len(json.load(sys.stdin)['value']))")
  if [[ "$COUNT" == "0" ]]; then
    echo "    MISSING environment variable $DEP"; MISSING=1
  else
    echo "    $DEP ok"
  fi
done

# Addressed by workflowid, which differs per environment: these are the two
# references in the definition that cannot travel to prod unchanged. Both must
# be ON — the PDF child holds every client if it is off, and the alert child is
# how a parked run reaches a human.
for CHILD in be610dd6-bf7b-f111-ab0f-000d3ada6ac0 6b0bff17-e79b-ed11-aad1-000d3ab479cf \
             0d0bc4d6-7f74-f111-ab0e-000d3ada6ac0 5d353829-ae5d-f111-a826-002248a29481; do
  # statecode FIRST, name last: the name contains spaces, and `read` would
  # otherwise split it and report the state of a word.
  read -r CHILD_STATE CHILD_NAME < <(
    api GET "workflows($CHILD)?\$select=name,statecode" | sed '$d' \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('statecode','-'),d.get('name','-'))" 2>/dev/null \
      || echo "- -")
  if [[ "$CHILD_STATE" == "-" ]]; then
    echo "    MISSING child flow $CHILD"; MISSING=1
  elif [[ "$CHILD_STATE" != "1" ]]; then
    echo "    child flow '$CHILD_NAME' is OFF — the call to it will fail"; MISSING=1
  else
    echo "    child flow '$CHILD_NAME' ok (on)"
  fi
done

# The two switches that decide whether a run says anything at all. Neither is
# an error in either position, and neither is this script's to change — but a
# rehearsal that produced drafts and a rehearsal that silently failed look
# identical afterwards unless someone knew which way these were set first.
echo "==> the two switches that decide what a run does (#102)"
for SWITCH in riivo_SendEmail riivo_BadDebtCanaryContactIds riivo_ReminderTestMode; do
  VALUE=$(api GET "environmentvariabledefinitions?\$select=defaultvalue&\$filter=schemaname%20eq%20'$SWITCH'&\$expand=environmentvariabledefinition_environmentvariablevalue(\$select=value)" \
    | sed '$d' | python3 -c "
import sys, json
rows = json.load(sys.stdin)['value']
if not rows:
    print('(not created)'); raise SystemExit
row = rows[0]
values = row.get('environmentvariabledefinition_environmentvariablevalue') or []
# The VALUE wins over the default wherever one exists — reading the default
# alone is how an environment gets misreported as something it is not.
print(repr(values[0]['value']) + '  (current value)' if values
      else repr(row.get('defaultvalue')) + '  (default; no value set)')")
  echo "    $SWITCH = $VALUE"
done
echo "    riivo_SendEmail off => the branded-email child creates every mail as a"
echo "    DRAFT and sends nothing, org-wide. That is a fine way to inspect a"
echo "    rendered message; it is not a send, and the run will say so."
echo "    A non-empty canary list => the run speaks ONLY to those clients."
echo "    THERE IS NO riivo_SendEmail FOR WHATSAPP (#103). One TTT WhatsApp"
echo "    number, no sandbox of it, no draft mode: dev and prod post to the same"
echo "    Meta phone number id, so a run that is not in test mode sends a REAL"
echo "    message from the live business number. Test mode and the canary list"
echo "    are the whole of the safety envelope."

# ---------------------------------------------------------- #103: the button --
# Meta bakes the Pay-now URL prefix into each template at APPROVAL time and
# rebuilds prefix + suffix itself, while riivo_PaymentLink_BaseUrl is
# per-environment. So the two can disagree, and in dev today they do — which no
# amount of correctness in the flow can fix, and which is invisible until
# somebody taps the button on a handset.
echo "==> the Pay-now button prefix (#103)"
APPROVED_PREFIX=$(npx --yes tsx -e '
import { APPROVED_BUTTON_URL_PREFIX } from "./flows/badDebtRecoveryTouches";
process.stdout.write(APPROVED_BUTTON_URL_PREFIX);
')
BASE_URL=$(api GET "environmentvariabledefinitions?\$select=defaultvalue&\$filter=schemaname%20eq%20'riivo_PaymentLink_BaseUrl'&\$expand=environmentvariabledefinition_environmentvariablevalue(\$select=value)" \
  | sed '$d' | python3 -c "
import sys, json
rows = json.load(sys.stdin)['value']
if not rows:
    print(''); raise SystemExit
values = rows[0].get('environmentvariabledefinition_environmentvariablevalue') or []
print(values[0]['value'] if values else rows[0].get('defaultvalue') or '')")
echo "    the 24 approved campaign templates rebuild: ${APPROVED_PREFIX}{token}"
echo "    riivo_PaymentLink_BaseUrl mints against:    ${BASE_URL}/p/{token}"
if [[ "${APPROVED_PREFIX%/p/}" != "$BASE_URL" ]]; then
  echo "    MISMATCH. A token minted here will NOT resolve at the address Meta"
  echo "    rebuilds, so the Pay-now button on a campaign-key WhatsApp message"
  echo "    cannot open its invoice in this environment however correct the"
  echo "    flow is. Verified 2026-09-11: a dev token answers 200 on the dev"
  echo "    host and 'Payment link not found' on the approved one."
  echo "    The D12 fallback template (ttt_invoice_reminder_paylink_v2) is"
  echo "    approved against the DEV host, so it is the mirror image and will"
  echo "    break in prod. Fixing this means re-approving templates in Meta, or"
  echo "    pointing both environments at one payment-link app — not a change"
  echo "    to this flow. Inspect the button by reading the token out of the"
  echo "    run report and loading ${BASE_URL}/p/{token} by hand."
fi

# ------------------------------------------------------- run table (#101) ----
# The tripwire reads its baseline from riivo_baddebtrun and records every run
# there. The table is created from the same module the flow reads its column
# names out of, so the two cannot drift; the creation is idempotent per column,
# which matters because a half-created table is otherwise a puzzle.
#
# A missing table is NOT a soft failure: the List that reads it sits upstream of
# everything the run produces, so the run ends having minted nothing. That is
# the fail-closed direction, and it is still a broken campaign — hence the abort
# below rather than a warning.
RUN_TABLE_LOGICAL=$(npx --yes tsx -e '
import { RUN_TABLE_LOGICAL } from "./flows/badDebtRunTable";
process.stdout.write(RUN_TABLE_LOGICAL);
')
echo "==> table $RUN_TABLE_LOGICAL"
TABLE_STATE=$(api GET "EntityDefinitions(LogicalName='$RUN_TABLE_LOGICAL')?\$select=LogicalName,EntitySetName" \
  | sed '$d' | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('EntitySetName', 'missing'))" 2>/dev/null || echo "missing")

if [[ "$TABLE_STATE" == "missing" ]]; then
  if $CHECK_ONLY; then
    echo "    MISSING (would create, with $(npx --yes tsx -e '
import { RUN_TABLE_ATTRIBUTES } from "./flows/badDebtRunTable";
process.stdout.write(String(RUN_TABLE_ATTRIBUTES.length));') columns)"
    MISSING=1
  else
    echo "    creating"
    TABLE_BODY=$(npx --yes tsx -e '
import { buildRunTableMetadata } from "./flows/badDebtRunTable";
process.stdout.write(JSON.stringify(buildRunTableMetadata()));
')
    RESP=$(api POST "EntityDefinitions" "$TABLE_BODY" "MSCRM.SolutionUniqueName: $SOLUTION_TABLES")
    CODE=$(tail -n1 <<<"$RESP")
    [[ "$CODE" =~ ^2 ]] || {
      echo "    FAILED (HTTP $CODE): $(sed '$d' <<<"$RESP" | head -c 600)" >&2; exit 1; }
    echo "    created (HTTP $CODE)"
    TABLE_STATE="created"
  fi
else
  echo "    exists, entity set '$TABLE_STATE'"
fi

if [[ "$TABLE_STATE" != "missing" ]]; then
  HAVE=$(api GET "EntityDefinitions(LogicalName='$RUN_TABLE_LOGICAL')/Attributes?\$select=LogicalName" \
    | sed '$d' | python3 -c "
import sys, json
print(' '.join(a['LogicalName'] for a in json.load(sys.stdin)['value']))")
  # One POST per declared column that is not there yet.
  npx --yes tsx -e '
import { RUN_TABLE_ATTRIBUTES, buildAttributeMetadata } from "./flows/badDebtRunTable";
const have = new Set(process.argv[2].split(" "));
for (const attribute of RUN_TABLE_ATTRIBUTES) {
  if (have.has(attribute.logicalName)) continue;
  console.log(attribute.logicalName + "\t" + JSON.stringify(buildAttributeMetadata(attribute)));
}
' -- "$HAVE" | while IFS=$'\t' read -r COLUMN BODY; do
    if $CHECK_ONLY; then
      echo "    MISSING column $COLUMN (would create)"; continue
    fi
    RESP=$(api POST "EntityDefinitions(LogicalName='$RUN_TABLE_LOGICAL')/Attributes" "$BODY" \
      "MSCRM.SolutionUniqueName: $SOLUTION_TABLES")
    CODE=$(tail -n1 <<<"$RESP")
    if [[ "$CODE" =~ ^2 ]]; then
      echo "    created column $COLUMN (HTTP $CODE)"
    else
      echo "    FAILED column $COLUMN (HTTP $CODE): $(sed '$d' <<<"$RESP" | head -c 400)" >&2
      exit 1
    fi
  done
  $CHECK_ONLY || echo "    all declared columns present"
fi

if [[ "$MISSING" != "0" ]]; then
  if $CHECK_ONLY; then
    echo "    ^ until these exist, every run either holds every client (a"
    echo "      missing payment-link variable) or fails at the tripwire before"
    echo "      it produces anything (a missing run table)"
  else
    echo "    ABORT: deploying now would break every run." >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------- flow ----
FLOW_NAME="Invoice - Scheduled - Send Bad Debt Recovery Touches"
echo "==> flow $FLOW_NAME"
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$FLOW_NAME")

echo "    rendering definition from flows/badDebtRecoveryTouches.ts"
CLIENTDATA=$(npx --yes tsx -e '
import { buildBadDebtRecoveryTouchesFlow } from "./flows/badDebtRecoveryTouches";
process.stdout.write(JSON.stringify(buildBadDebtRecoveryTouchesFlow()));
')

READ_STATE=$(cat <<'PY2'
import sys, json
rendered = sys.argv[1]
rows = json.load(sys.stdin)["value"]
row = rows[0] if rows else {}
print(row.get("workflowid", "-"), row.get("statecode", "-"), len(rows),
      "same" if row.get("clientdata") == rendered else "differs")
PY2
)
read -r FOUND FOUND_STATE FOUND_COUNT SAME < <(
  api GET "workflows?\$select=workflowid,statecode,clientdata&\$filter=name%20eq%20'$ENC'%20and%20category%20eq%205" \
    | sed '$d' | python3 -c "$READ_STATE" "$CLIENTDATA")
if [[ "$FOUND_COUNT" -gt 1 ]]; then
  echo "    ABORT: $FOUND_COUNT flows share this name — resolve by hand before deploying" >&2
  exit 1
fi

if [[ "$FOUND" != "-" ]]; then
  echo "    exists: $FOUND  statecode=$FOUND_STATE (0=draft/off)  definition=$SAME"
  if [[ "$SAME" == "same" ]]; then
    echo "    deployed definition matches this working tree — nothing to do"
    exit 0
  fi
  if [[ "$FOUND_STATE" != "0" ]]; then
    echo "    ABORT: the flow is switched on. Turning it off is a human act (D9)," >&2
    echo "           and this script will not delete a running flow." >&2
    exit 1
  fi
  if ! $REPLACE; then
    echo "    definition has CHANGED since it was deployed."
    echo "    clientdata cannot be PATCHed, so updating means: POST the new one,"
    echo "    verify, then DELETE $FOUND — which mints a new workflowid."
    echo "    Re-run with --replace to do that."
    exit 0
  fi
  echo "    replacing (POST new, verify, delete old)"
else
  if $CHECK_ONLY; then echo "    MISSING (would create)"; exit 0; fi
fi
BODY=$(python3 - "$FLOW_NAME" "$CLIENTDATA" <<'PY'
import sys, json
print(json.dumps({
    "name": sys.argv[1],
    "clientdata": sys.argv[2],
    # Modern cloud flow: category 5, type 1, scope 4, mode 0, primaryentity none.
    "category": 5, "type": 1, "scope": 4, "mode": 0, "primaryentity": "none",
    "description": (
        "Bad-debt recovery: selection, campaign key, message inputs and the "
        "email channel (issues #98-#102). Selects one client per run from "
        "open riivo_baddebt rows, resolves the campaign-key WhatsApp template "
        "for the touch that is due, mints a payment token and renders the "
        "invoice PDF - holding any client whose token or PDF cannot be "
        "produced - and EMAILS them through the house child 'Email - Child - "
        "Build Branded HTML Email, Create or Send', which creates the "
        "Dataverse email row, attaches the PDF and performs the bound "
        "SendEmail. No Outlook connector anywhere. It also sends the WhatsApp "
        "template the campaign key resolved (#103): the invoice PDF is "
        "uploaded to Meta per client and delivered as the template's document "
        "header, the body carries the client's first name and the outstanding "
        "amount - three parameters, with the invoice number, on the D12 "
        "fallback template, which is approved with a different body - and the "
        "Pay-now button is passed the BARE payment token, because Meta rebuilds "
        "the approved URL prefix itself. Every attempt is logged to "
        "riivo_whatsappcommunicationses, sent or refused. The touch bookkeeping "
        "is gated on a channel reporting a send, so a suppressed recipient, a "
        "skipped send, a draft left by riivo_SendEmail and a template Meta "
        "refused all advance no counter. There is no riivo_SendEmail for "
        "WhatsApp: dev and prod post to the same Meta phone number id, so any "
        "run not in test mode sends real messages from the live TTT number. "
        "riivo_BadDebtCanaryContactIds restricts a run to named clients for a "
        "rehearsal or a canary; while it is set the run skips the volume "
        "tripwire, records itself as 'canary' so it never becomes a baseline, "
        "and emails the team to say it was restricted. "
        "Mon/Thu 09:45 SAST - 09:45 not 09:30 because "
        "'Bad Debt Referral & Owner Digest' (dd5a766f) runs daily 09:30 and "
        "creates riivo_baddebt rows. The definition is generated and tested in "
        "flows/badDebtRecoveryTouches.ts; edit it there, not in the designer. "
        "#101 adds the volume tripwire: after selection and before anything is "
        "minted or rendered, the run compares its selected client count "
        "against the last run that was acted on (riivo_baddebtrun) and, if "
        "they disagree by more than "
        "riivo_BadDebtVolumeChangeThresholdPercent - or the selection has "
        "emptied - alerts the team and terminates having produced nothing."),
}))
PY
)
RESP=$(api POST "workflows" "$BODY" "MSCRM.SolutionUniqueName: $SOLUTION_FLOWS")
CODE=$(tail -n1 <<<"$RESP")
if [[ "$CODE" =~ ^2 ]]; then
  echo "    created (HTTP $CODE) — DRAFT / off, as intended"
else
  echo "    FAILED (HTTP $CODE): $(sed '$d' <<<"$RESP" | head -c 600)"; exit 1
fi

echo "==> verifying"
VERIFY=$(cat <<'PY2'
import sys, json
rendered, old = sys.argv[1], sys.argv[2]
new = [r for r in json.load(sys.stdin)["value"] if r["workflowid"] != old]
if len(new) != 1:
    sys.exit("    FAILED: expected exactly one new flow, found %d" % len(new))
row = new[0]
if row["clientdata"] != rendered:
    sys.exit("    FAILED: deployed clientdata differs from the rendered definition")
print(row["workflowid"])
PY2
)
NEW=$(api GET "workflows?\$select=workflowid,statecode,clientdata&\$filter=name%20eq%20'$ENC'%20and%20category%20eq%205" \
  | sed '$d' | python3 -c "$VERIFY" "$CLIENTDATA" "$FOUND") || { echo "$NEW" >&2; exit 1; }
echo "    $NEW  statecode=0 (draft/off), clientdata byte-identical to the module"

# Only now is the old one expendable: the replacement is verified in place.
if [[ "$FOUND" != "-" ]]; then
  echo "==> deleting the superseded flow $FOUND"
  CODE=$(api DELETE "workflows($FOUND)" | tail -n1)
  [[ "$CODE" =~ ^2 ]] && echo "    deleted (HTTP $CODE)" \
    || { echo "    FAILED (HTTP $CODE) — two flows now share this name, resolve by hand" >&2; exit 1; }
fi

echo
echo "Remaining, human-only (connection-gated to riivo Admin):"
echo "  1. open the flow in the maker portal, confirm the riivo_dataverse connection reference"
echo "  2. run it once on demand, in test mode, to produce the dry-run report"
echo "  3. diff that report against the comms tool's recipient list for the same day"
echo "  4. #99: read Compose_|_Dry_Run_Report - every touch carries ageBand,"
echo "     relationship, touch and templateName; every held row carries a reason"
echo "  5. #100: every touch also carries paymentLink and documentBytes > 0."
echo "     The parameters are declared with EMPTY defaults so no key reaches"
echo "     git, which makes that run the proof the environment variables"
echo "     actually resolve: a blank paymentLink means the binding, not the"
echo "     endpoint, is what failed."
echo "  6. #101: that run writes the first riivo_baddebtrun row, and with no"
echo "     earlier one to compare against it must PROCEED — check the row says"
echo "     outcome=proceeded, previouscount=0, and the report carries"
echo "     tripwireVerdict=proceed. A second run then has a baseline, which is"
echo "     what makes the tripwire exercisable: to see it park, set that"
echo "     row's riivo_selectedcount far from the live count (or drop the"
echo "     threshold to 1) and run again. Expect: nothing minted, a Flow"
echo "     Failure email carrying both counts, and a second row saying"
echo "     outcome=aborted. Put the row back, or set it to accepted, and the"
echo "     next run proceeds again."
echo
echo "  #102: the email channel, in four steps and in this order."
echo "  7. DRAFT REHEARSAL. Put the three colleague contact ids in"
echo "     riivo_BadDebtCanaryContactIds, set riivo_ReminderTestMode to false,"
echo "     and leave riivo_SendEmail OFF. Run it. Nothing is sent; each"
echo "     selected client gets a branded email row saved as a draft, with the"
echo "     PDF attached and the Pay-now button rendered. Open one in Dataverse"
echo "     and READ IT: the amount, the invoice number, the attachment, and"
echo "     the button. Load the button's link and confirm it resolves to that"
echo "     invoice's payment page. Expect outcome=canary, canarycount=3,"
echo "     emailsSent=0, and every touch row carrying the note that"
echo "     riivo_SendEmail is off."
echo "  8. LIVE COLLEAGUE REHEARSAL. Same canary list, then switch"
echo "     riivo_SendEmail ON, run, and SWITCH IT BACK OFF. It is org-wide:"
echo "     71 flows read it and 16 event-triggered ones are on, so any record"
echo "     edited in dev during that window can mail a real contact. Expect"
echo "     real mail in the three mailboxes, the message on each client's"
echo "     timeline, emailsSent=3, and riivo_campaignsendcount advanced by"
echo "     exactly one on those three bad-debt rows and on no others."
echo "  9. CANARY. Widen the list to a small number of real clients, repeat"
echo "     step 8, and read what they received before going further."
echo " 10. CLEAR riivo_BadDebtCanaryContactIds. Until it is empty the campaign"
echo "     is only speaking to those clients — which is what the Flow Failure"
echo "     email saying RESTRICTED on every run is there to keep nagging"
echo "     about."
echo
echo "  #103: the WhatsApp channel. READ THIS BEFORE RUNNING ANYTHING."
echo "  There is no draft mode. Dev and prod post to the SAME Meta phone number"
echo "  id, so the first run with test mode off and a canary list set sends a"
echo "  real WhatsApp from the live TTT business number to a real handset."
echo "  There is no step 7 equivalent here — no free rehearsal — so the canary"
echo "  list is not a convenience, it is the only thing standing between a run"
echo "  and the whole book."
echo " 11. COLLEAGUE REHEARSAL. Canary list = contacts whose mobile numbers are"
echo "     yours (Luc, Nic, Roscoe), riivo_ReminderTestMode false. Run it."
echo "     On each handset check: the document opens and is the right invoice"
echo "     (not a file of base64 text — that failure mode is real and is why"
echo "     the upload passes bytes rather than an interpolated string); the"
echo "     greeting names the client; the amount matches ttt_outstanding; and"
echo "     the Pay-now button opens the right invoice's payment page. If the"
echo "     button 404s, check the prefix mismatch reported above before"
echo "     assuming the flow is wrong — in dev it is expected."
echo " 12. Confirm the bookkeeping: whatsAppsSent in the report equals the"
echo "     number of handsets that buzzed, riivo_campaignsendcount advanced by"
echo "     exactly one on those bad-debt rows and no others, and each client"
echo "     has ONE riivo_whatsappcommunications row with status sent (463630001)"
echo "     regarding the invoice. A row with status failed (463630003) carries"
echo "     Meta's own words in riivo_failurereason — read it rather than"
echo "     guessing."
echo " 13. Opt one colleague OUT (riivo_whatsappoptinout false) and re-run:"
echo "     they must receive nothing, and their touch row must say so."
echo " 14. CANARY on a small number of real clients, then read what they got."
echo " 15. CLEAR riivo_BadDebtCanaryContactIds — step 10, again, and it matters"
echo "     more now that both channels speak."
