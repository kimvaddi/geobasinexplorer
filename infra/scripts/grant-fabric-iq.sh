#!/usr/bin/env bash
# Lets the app's scientists ask Fabric IQ as the signed-in person (docs/FOUNDRY_AGENTS.md, "Fabric IQ as the
# person"). Safe to rerun; infra/scripts/deploy-site.sh runs it after every deployment.
#   infra/scripts/grant-fabric-iq.sh <sign-in app ID> <agents identity principal ID>
# 1. The sign-in registration may call Foundry (Azure Machine Learning Services, the resource behind https://ai.azure.com,
#    user_impersonation) on a person's behalf, and asks at sign-in for its own user_impersonation scope, so the token store
#    keeps a token for the API itself. Both get tenant-wide admin consent, as do the sign-in scopes, so no person is asked.
# 2. The registration trusts the app's agents identity (id-gbx-site-agents) through a federated identity credential, so the
#    API makes the exchange without a client secret.
# 3. The hosted scientists' own identities hold Foundry User on the project, which Fabric IQ through a toolbox requires of
#    an agent's runtime identity.
# Each person still needs Foundry Agent Consumer on the agents (or Foundry User on the project) and read access to the
# ontology and its data in Fabric; without them a run starts as the app and the scientists use the typed knowledge tools.
# Learn: https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity
#        https://learn.microsoft.com/azure/foundry/agents/how-to/tools/fabric-iq#prerequisites
#        https://learn.microsoft.com/azure/foundry/agents/how-to/tools/tool-authentication
set -euo pipefail
USAGE="usage: infra/scripts/grant-fabric-iq.sh <sign-in app ID> <agents identity principal ID>"
APP_ID="${1:?$USAGE}"
MI_PRINCIPAL="${2:?$USAGE}"
. "$(dirname "$0")/lib.sh"
gbx_agents
SUB="$AGENTS_SUB"
PROJECT_ID="$GBX_V2_PROJECT_ID"
# gbx-copilot and gbx-coscientist (deploy_hosted.py --identities, recorded by deploy.sh hosted).
AGENT_IDENTITIES="${GBX_AGENT_IDENTITIES//,/ }"
FOUNDRY_APP=18a66f5f-dbdf-4c17-9dd7-1634712a9cbe
GRAPH_APP=00000003-0000-0000-c000-000000000000
FIC_NAME=site-agents-identity
TENANT="$(az account show --query tenantId -o tsv)"
GRAPH=https://graph.microsoft.com/v1.0

# 1. Declared permissions, then tenant-wide consent for each resource.
FOUNDRY_SCOPE_ID="$(az ad sp show --id "$FOUNDRY_APP" --query "oauth2PermissionScopes[?value=='user_impersonation'].id | [0]" -o tsv)"
OWN_SCOPE_ID="$(az ad app show --id "$APP_ID" --query "api.oauth2PermissionScopes[?value=='user_impersonation'].id | [0]" -o tsv)"
for pair in "$FOUNDRY_APP=$FOUNDRY_SCOPE_ID" "$APP_ID=$OWN_SCOPE_ID"; do
  api="${pair%%=*}" scope="${pair#*=}"
  declared="$(az ad app show --id "$APP_ID" --query "length(requiredResourceAccess[?resourceAppId=='$api'].resourceAccess[] | [?id=='$scope'])" -o tsv)"
  if [ "$declared" = "0" ]; then
    az ad app permission add --id "$APP_ID" --api "$api" --api-permissions "$scope=Scope" -o none 2>/dev/null
    echo "The sign-in registration now declares $api user_impersonation."
  fi
done
APP_SP="$(az ad sp show --id "$APP_ID" --query id -o tsv)"
consent() {  # <resource app ID> <space-separated scopes>
  local resource_sp url id have missing=""
  resource_sp="$(az ad sp show --id "$1" --query id -o tsv)"
  url="$GRAPH/oauth2PermissionGrants?\$filter=clientId%20eq%20'$APP_SP'%20and%20resourceId%20eq%20'$resource_sp'"
  id="$(az rest --method get --url "$url" --query "value[?consentType=='AllPrincipals'] | [0].id" -o tsv)"
  if [ -z "$id" ]; then
    az rest --method post --url "$GRAPH/oauth2PermissionGrants" -o none \
      --body "{\"clientId\":\"$APP_SP\",\"consentType\":\"AllPrincipals\",\"resourceId\":\"$resource_sp\",\"scope\":\"$2\"}"
    echo "Granted tenant-wide consent for $1: $2."
    return
  fi
  have=" $(az rest --method get --url "$url" --query "value[?consentType=='AllPrincipals'] | [0].scope" -o tsv) "
  for s in $2; do case "$have" in *" $s "*) ;; *) missing="$missing $s" ;; esac; done
  if [ -n "$missing" ]; then
    az rest --method patch --url "$GRAPH/oauth2PermissionGrants/$id" -o none --body "{\"scope\":\"$(echo "$have$missing" | xargs)\"}"
    echo "Extended tenant-wide consent for $1 with$missing."
  fi
}
consent "$FOUNDRY_APP" "user_impersonation"
consent "$APP_ID" "user_impersonation"
consent "$GRAPH_APP" "openid profile email offline_access"

# 2. The agents identity as the registration's credential.
if [ -z "$(az ad app federated-credential list --id "$APP_ID" --query "[?name=='$FIC_NAME'].name | [0]" -o tsv)" ]; then
  az ad app federated-credential create --id "$APP_ID" -o none --parameters "{\"name\":\"$FIC_NAME\",\"issuer\":\"https://login.microsoftonline.com/$TENANT/v2.0\",\"subject\":\"$MI_PRINCIPAL\",\"audiences\":[\"api://AzureADTokenExchange\"],\"description\":\"The app's agents identity stands in for a client secret when the API asks Foundry on a person's behalf.\"}"
  echo "The sign-in registration now trusts the agents identity $MI_PRINCIPAL."
fi

# 3. Foundry User on the project for the hosted scientists' own identities, retried while a new identity replicates.
FOUNDRY_USER="$(az role definition list --subscription "$SUB" --name "Foundry User" --query "[0].name" -o tsv)"
for p in $AGENT_IDENTITIES; do
  if [ "$(az role assignment list --subscription "$SUB" --assignee "$p" --role "$FOUNDRY_USER" --scope "$PROJECT_ID" --query "length(@)" -o tsv)" != "0" ]; then continue; fi
  for attempt in 1 2 3 4 5 6; do
    if az role assignment create --subscription "$SUB" --assignee-object-id "$p" --assignee-principal-type ServicePrincipal --role "$FOUNDRY_USER" --scope "$PROJECT_ID" -o none 2>/dev/null; then
      echo "The agent identity $p now holds Foundry User on the project."; break
    fi
    if [ "$attempt" = 6 ]; then echo "Couldn't assign Foundry User to $p; rerun in a few minutes." >&2; false; fi
    sleep 10
  done
done
