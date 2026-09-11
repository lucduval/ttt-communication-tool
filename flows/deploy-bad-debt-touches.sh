#!/usr/bin/env bash
#
# Deploys `Invoice - Scheduled - Send Bad Debt Recovery Touches` (issues #98,
# #99) into the TTT **dev** org. Creates the flow as a DRAFT (off) — per D9, no
# agent and no script activates anything; Luc promotes dev -> prod by hand.
#
# Idempotent: re-running skips anything that already exists. Safe to run twice.
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

# ---------------------------------------------------------------- env var ----
VAR_NAME="riivo_BadDebtMinDaysBetweenTouches"
echo "==> environment variable $VAR_NAME"
EXISTING=$(api GET "environmentvariabledefinitions?\$select=schemaname&\$filter=schemaname%20eq%20'$VAR_NAME'" \
  | sed '$d' | python3 -c "import sys,json;print(len(json.load(sys.stdin)['value']))")
if [[ "$EXISTING" != "0" ]]; then
  echo "    already exists — skipping"
elif $CHECK_ONLY; then
  echo "    MISSING (would create)"
else
  VAR_BODY=$(python3 -c '
import json
print(json.dumps({
  "schemaname": "riivo_BadDebtMinDaysBetweenTouches",
  "displayname": "Bad Debt Min Days Between Touches",
  "type": 100000000,
  "defaultvalue": "2",
  "description": (
    "Minimum whole days between two bad-debt recovery touches to the same "
    "riivo_baddebt record. Guards the Monday/Thursday cadence against a "
    "same-day re-run or a Power Automate retry, which would otherwise "
    "double-send: Power Automate has no transactions, so this recency test is "
    "the only duplicate defence. Default 2 blocks same-day and next-day "
    "repeats while leaving the 3-day Mon->Thu gap intact."),
}))')
  RESP=$(api POST "environmentvariabledefinitions" "$VAR_BODY" "MSCRM.SolutionUniqueName: $SOLUTION_VARS")
  CODE=$(tail -n1 <<<"$RESP")
  if [[ "$CODE" =~ ^2 ]]; then
    echo "    created (HTTP $CODE)"
  else
    echo "    FAILED (HTTP $CODE): $(sed '$d' <<<"$RESP" | head -c 400)"; exit 1
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
        "Bad-debt recovery selection and campaign key (issues #98, #99). "
        "Selects one client per run from open riivo_baddebt rows, resolves the "
        "campaign-key WhatsApp template for the touch that is due, and SENDS "
        "NOTHING - the touch bookkeeping is gated on a send outcome that is "
        "false until #102/#103. Mon/Thu 09:45 SAST - 09:45 not 09:30 because "
        "'Bad Debt Referral & Owner Digest' (dd5a766f) runs daily 09:30 and "
        "creates riivo_baddebt rows. The definition is generated and tested in "
        "flows/badDebtRecoveryTouches.ts; edit it there, not in the designer."),
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
