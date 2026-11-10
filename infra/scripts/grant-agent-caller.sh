#!/usr/bin/env bash
# Lets one identity call version 2's hosted scientists on behalf of the signed-in person (docs/FOUNDRY_AGENTS.md, "How
# the app calls the squad"). At the scope of each named agent alone, it assigns Foundry Agent Consumer, the least-privilege
# built-in role for an agent endpoint, and the custom role "GeoBasin Agent User Delegation (<Foundry account>)", which
# holds only the data action that lets a trusted middle tier send x-ms-user-identity, because no built-in role includes it.
# Custom role names are unique across the directory, so the account's name keeps two deployments in one tenant apart.
# Safe to rerun.
#   infra/scripts/grant-agent-caller.sh <principal-object-id> <agent> [<agent> ...]
# Learn: https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry#agent-scope-role-assignments
#        https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agent-permissions#delegate-the-end-user-identity
set -euo pipefail
PRINCIPAL="${1:?usage: infra/scripts/grant-agent-caller.sh <principal-object-id> <agent> [<agent> ...]}"
shift
if [ "$#" -eq 0 ]; then echo "Name at least one agent." >&2; false; fi
. "$(dirname "$0")/lib.sh"
gbx_agents
SUB="$AGENTS_SUB"
ACCOUNT_ID="$GBX_V2_ACCOUNT_ID"
PROJECT_ID="$GBX_V2_PROJECT_ID"
CONSUMER=eed3b665-ab3a-47b6-8f48-c9382fb1dad6
DELEGATION="GeoBasin Agent User Delegation (${ACCOUNT_ID##*/})"

delegation_id() { az role definition list --subscription "$SUB" --custom-role-only true --name "$DELEGATION" --scope "$ACCOUNT_ID" --query "[0].name" -o tsv; }
DELEGATION_ID="$(delegation_id)"
if [ -z "$DELEGATION_ID" ]; then
  DEF="$(mktemp)"
  trap 'rm -f "$DEF"' EXIT
  python3 - "$DEF" "$DELEGATION" "$ACCOUNT_ID" <<'PY'
import json, sys
path, name, scope = sys.argv[1:4]
json.dump({"Name": name, "IsCustom": True,
           "Description": "Lets the GeoBasin API tell a hosted scientist which signed-in person a run is for (x-ms-user-identity), so Foundry keeps the run in that person's own session.",
           "Actions": [], "NotActions": [], "NotDataActions": [],
           "DataActions": ["Microsoft.CognitiveServices/accounts/AIServices/agents/endpoints/UserIdentityImpersonation/action"],
           "AssignableScopes": [scope]}, open(path, "w"))
PY
  az role definition create --subscription "$SUB" --role-definition "$DEF" -o none
  for _ in 1 2 3 4 5 6 7 8 9 10; do DELEGATION_ID="$(delegation_id)"; [ -n "$DELEGATION_ID" ] && break; sleep 10; done
  if [ -z "$DELEGATION_ID" ]; then echo "The custom role $DELEGATION was created but can't be read back yet; rerun in a few minutes." >&2; false; fi
  echo "Created the custom role $DELEGATION ($DELEGATION_ID)."
fi

# A new identity or role can take a minute to replicate, so each assignment is retried before the script gives up.
assign() {
  local role="$1" scope="$2" err
  if [ -n "$(az role assignment list --subscription "$SUB" --assignee "$PRINCIPAL" --role "$role" --scope "$scope" --query "[0].id" -o tsv 2>/dev/null)" ]; then return 0; fi
  for _ in 1 2 3 4 5 6; do
    if err="$(az role assignment create --subscription "$SUB" --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal --role "$role" --scope "$scope" -o none 2>&1)"; then
      echo "Assigned $role on ${scope##*/projects/}."; return 0
    fi
    if echo "$err" | grep -q "RoleAssignmentExists"; then return 0; fi
    sleep 20
  done
  echo "$err" >&2; return 1
}
for AGENT in "$@"; do
  assign "$CONSUMER" "$PROJECT_ID/agents/$AGENT"
  assign "$DELEGATION_ID" "$PROJECT_ID/agents/$AGENT"
done
