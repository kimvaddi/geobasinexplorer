#!/usr/bin/env bash
# Shared settings for the deployment scripts. Source it from a script; don't run it.
#   . "$(dirname "$0")/lib.sh"
# It loads infra/config/environment.env (your settings) and infra/config/environment.generated.env (values the deployment
# discovers as it goes, such as the sign-in app ID and the Fabric item IDs), and offers helpers that read the outputs of
# the foundation and version 2 Foundry deployments. Neither file is committed (.gitignore).
GBX_INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GBX_ROOT="$(cd "$GBX_INFRA/.." && pwd)"
GBX_ENV_FILE="${GBX_ENV_FILE:-$GBX_INFRA/config/environment.env}"
GBX_GENERATED_FILE="${GBX_GENERATED_FILE:-$GBX_INFRA/config/environment.generated.env}"
if [ ! -f "$GBX_ENV_FILE" ]; then
  echo "No $GBX_ENV_FILE yet. Copy infra/config/environment.example.env to it and fill it in." >&2
  return 1 2>/dev/null || false
fi
set -a
# shellcheck disable=SC1090
. "$GBX_ENV_FILE"
# shellcheck disable=SC1090
if [ -f "$GBX_GENERATED_FILE" ]; then . "$GBX_GENERATED_FILE"; fi
set +a

: "${GBX_SUBSCRIPTION_ID:?Set GBX_SUBSCRIPTION_ID in $GBX_ENV_FILE}"
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
  echo "The deployment scripts need Python 3.11 or later as python3; found $(python3 --version 2>&1). Put a newer python3 first on PATH." >&2
  return 1 2>/dev/null || false
fi
export GBX_AGENTS_SUBSCRIPTION_ID="${GBX_AGENTS_SUBSCRIPTION_ID:-$GBX_SUBSCRIPTION_ID}"
export GBX_LOCATION="${GBX_LOCATION:-westus3}"
export GBX_BUDGET_START_DATE="${GBX_BUDGET_START_DATE:-$(date -u +%Y-%m-01)}"
export GBX_BRAND="${GBX_BRAND:-geobasin}"
SUB="$GBX_SUBSCRIPTION_ID"
AGENTS_SUB="$GBX_AGENTS_SUBSCRIPTION_ID"
APP_RG=rg-geobasin-app
EDGE_RG=rg-geobasin-edge
export SUB AGENTS_SUB APP_RG EDGE_RG GBX_ROOT GBX_INFRA

# Fails with a clear message unless every named setting has a value.
gbx_require() {
  local name
  for name in "$@"; do
    if [ -z "$(printenv "$name")" ]; then
      echo "Set $name first (infra/config/environment.example.env explains it)." >&2
      return 1
    fi
  done
}

# Records a discovered value in environment.generated.env and exports it.
gbx_remember() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  if [ -f "$GBX_GENERATED_FILE" ]; then grep -v "^$name=" "$GBX_GENERATED_FILE" > "$tmp" || true; fi
  printf '%s=%q\n' "$name" "$value" >> "$tmp"
  mv "$tmp" "$GBX_GENERATED_FILE"
  export "$name=$value"
}

_gbx_output() {  # <outputs json> <output name>; Bicep wraps each value as {"value": ...}, Terraform doesn't
  python3 -c "import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2], ''); print(v.get('value', '') if isinstance(v, dict) else v)" "$1" "$2"
}

# The outputs of one deployment: Bicep by default, or Terraform with GBX_IAC=terraform (infra/terraform outputs the same names).
_gbx_outputs() {  # <bicep deployment name> <subscription> <terraform output name>
  if [ "${GBX_IAC:-bicep}" = "terraform" ]; then
    terraform -chdir="$GBX_INFRA/terraform" output -json "$3"
  else
    az deployment sub show --subscription "$2" -n "$1" --query properties.outputs -o json
  fi
}

# Exports the foundation deployment's outputs (infra/bicep/main.bicep) as the GBX_* names the parameter files read.
gbx_foundation() {
  local out
  out="$(_gbx_outputs gbx-foundation "$SUB" foundation)"
  GBX_SUFFIX="$(_gbx_output "$out" suffix)"
  GBX_ENVIRONMENT_NAME="$(_gbx_output "$out" environmentName)"
  GBX_ENVIRONMENT_DEFAULT_DOMAIN="$(_gbx_output "$out" environmentDefaultDomain)"
  GBX_APPI_CONNECTION_STRING="$(_gbx_output "$out" appInsightsConnectionString)"
  GBX_ACR_LOGIN_SERVER="$(_gbx_output "$out" acrLoginServer)"
  GBX_ACR_NAME="$(_gbx_output "$out" acrName)"
  GBX_WEB_IDENTITY_ID="$(_gbx_output "$out" webIdentityId)"
  GBX_WEB_CLIENT_ID="$(_gbx_output "$out" webClientId)"
  GBX_INGEST_IDENTITY_ID="$(_gbx_output "$out" ingestIdentityId)"
  GBX_INGEST_CLIENT_ID="$(_gbx_output "$out" ingestClientId)"
  GBX_STORAGE_ACCOUNT="$(_gbx_output "$out" storageAccountName)"
  GBX_KEY_VAULT_NAME="$(_gbx_output "$out" keyVaultName)"
  GBX_FOUNDRY_NAME="$(_gbx_output "$out" foundryName)"
  GBX_FOUNDRY_ENDPOINT="$(_gbx_output "$out" foundryEndpoint)"
  GBX_SEARCH_NAME="$(_gbx_output "$out" searchName)"
  GBX_SEARCH_ENDPOINT="$(_gbx_output "$out" searchEndpoint)"
  GBX_DOCINTEL_ENDPOINT="$(_gbx_output "$out" docIntelEndpoint)"
  GBX_ACTION_GROUP_ID="$(_gbx_output "$out" actionGroupId)"
  GBX_MAPS_ACCOUNT_NAME="$(_gbx_output "$out" mapsAccountName)"
  GBX_MAPS_ACCOUNT_CLIENT_ID="$(_gbx_output "$out" mapsAccountClientId)"
  GBX_MAPS_IDENTITY_ID="$(_gbx_output "$out" mapsIdentityId)"
  GBX_MAPS_IDENTITY_CLIENT_ID="$(_gbx_output "$out" mapsIdentityClientId)"
  GBX_SPATIAL_IDENTITY_ID="$(_gbx_output "$out" spatialIdentityId)"
  GBX_ENVIRONMENT_ID="/subscriptions/$SUB/resourceGroups/$APP_RG/providers/Microsoft.App/managedEnvironments/$GBX_ENVIRONMENT_NAME"
  GBX_LOG_ANALYTICS_ID="/subscriptions/$SUB/resourceGroups/rg-geobasin-ops/providers/Microsoft.OperationalInsights/workspaces/log-gbx-$GBX_SUFFIX"
  export GBX_SUFFIX GBX_ENVIRONMENT_NAME GBX_ENVIRONMENT_DEFAULT_DOMAIN GBX_APPI_CONNECTION_STRING GBX_ACR_LOGIN_SERVER \
    GBX_ACR_NAME GBX_WEB_IDENTITY_ID GBX_WEB_CLIENT_ID GBX_INGEST_IDENTITY_ID GBX_INGEST_CLIENT_ID GBX_STORAGE_ACCOUNT \
    GBX_KEY_VAULT_NAME GBX_FOUNDRY_NAME GBX_FOUNDRY_ENDPOINT GBX_SEARCH_NAME GBX_SEARCH_ENDPOINT GBX_DOCINTEL_ENDPOINT \
    GBX_ACTION_GROUP_ID GBX_MAPS_ACCOUNT_NAME GBX_MAPS_ACCOUNT_CLIENT_ID GBX_MAPS_IDENTITY_ID GBX_MAPS_IDENTITY_CLIENT_ID \
    GBX_SPATIAL_IDENTITY_ID GBX_ENVIRONMENT_ID GBX_LOG_ANALYTICS_ID
  if [ -z "$GBX_SUFFIX" ]; then echo "No gbx-foundation deployment in $SUB yet; run infra/scripts/deploy.sh foundation." >&2; return 1; fi
}

# Exports the version 2 Foundry deployment's outputs (infra/bicep/agents/foundry.bicep).
gbx_agents() {
  local out
  out="$(_gbx_outputs gbx2-foundry "$AGENTS_SUB" agents)"
  GBX_V2_RESOURCE_GROUP="$(_gbx_output "$out" resourceGroup)"
  GBX_V2_ACCOUNT_NAME="$(_gbx_output "$out" accountName)"
  GBX_V2_PROJECT_NAME="$(_gbx_output "$out" projectName)"
  GBX_V2_PROJECT_ENDPOINT="$(_gbx_output "$out" projectEndpoint)"
  GBX_V2_ACCOUNT_ID="/subscriptions/$AGENTS_SUB/resourceGroups/$GBX_V2_RESOURCE_GROUP/providers/Microsoft.CognitiveServices/accounts/$GBX_V2_ACCOUNT_NAME"
  GBX_V2_PROJECT_ID="$GBX_V2_ACCOUNT_ID/projects/$GBX_V2_PROJECT_NAME"
  export GBX_V2_RESOURCE_GROUP GBX_V2_ACCOUNT_NAME GBX_V2_PROJECT_NAME GBX_V2_PROJECT_ENDPOINT GBX_V2_ACCOUNT_ID GBX_V2_PROJECT_ID
  if [ -z "$GBX_V2_ACCOUNT_NAME" ]; then echo "No gbx2-foundry deployment in $AGENTS_SUB yet; run infra/scripts/deploy.sh agents." >&2; return 1; fi
}

gbx_api_version() { sed -n 's/^  "version": "\(.*\)",$/\1/p' "$GBX_ROOT/services/api/package.json"; }
