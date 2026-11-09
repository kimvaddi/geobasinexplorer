#!/usr/bin/env bash
# Creates the web app's own sign-in registration, or reuses it, and assigns the people who may sign in.
#   infra/scripts/site-signin.sh       prints the application (client) ID, which deploy.sh records as GBX_SITE_APP_ID
# The registration is single tenant, with assignment required, a user_impersonation scope with the Azure CLI
# pre-authorized for operator tests, and the redirect address of GBX_SITE_HOST. Its app roles are GeoBasin.Tester (sign in
# and use the app; shown as "GeoBasin user"), GeoBasin.Owner (publish uploads, approve live-lane extractions, roll back
# expert reviews) and GeoBasin.Tools, which the scientists' hosted agents hold so that they can call the read-only tool
# server with their own identity (docs/FOUNDRY_AGENTS.md, Identity and the run ticket). GBX_SIGNIN_PRINCIPALS and
# GBX_OWNER_PRINCIPALS (object IDs of users or groups) receive the user and owner roles; the operator gets both.
# Learn: https://learn.microsoft.com/cli/azure/ad/app#az-ad-app-create
#        https://learn.microsoft.com/entra/identity-platform/howto-add-app-roles-in-apps
set -euo pipefail
. "$(dirname "$0")/lib.sh"
gbx_require GBX_SITE_HOST GBX_OPERATOR_OBJECT_ID
NAME="${GBX_SITE_APP_NAME:-GeoBasin Explorer AI}"
HOST="$GBX_SITE_HOST"
USERS="${GBX_SIGNIN_PRINCIPALS:-},$GBX_OPERATOR_OBJECT_ID"
OWNERS="${GBX_OWNER_PRINCIPALS:-},$GBX_OPERATOR_OBJECT_ID"
APP_ID="$(az ad app list --display-name "$NAME" --query '[0].appId' -o tsv)"
if [ -z "$APP_ID" ]; then
  ROLES='[{"allowedMemberTypes":["User"],"description":"Signs in to GeoBasin Explorer AI and uses it.","displayName":"GeoBasin user","isEnabled":true,"value":"GeoBasin.Tester"},{"allowedMemberTypes":["User"],"description":"Publishes uploaded documents and rolls back expert reviews in GeoBasin Explorer AI.","displayName":"GeoBasin owner","isEnabled":true,"value":"GeoBasin.Owner"},{"allowedMemberTypes":["Application"],"description":"Lets a GeoBasin scientist agent call the read-only tool server with its own identity.","displayName":"GeoBasin tools","isEnabled":true,"value":"GeoBasin.Tools"}]'
  APP_ID="$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMyOrg --web-redirect-uris "https://$HOST/.auth/login/aad/callback" \
    --enable-id-token-issuance true --requested-access-token-version 2 --app-roles "$ROLES" --query appId -o tsv)"
  az ad app update --id "$APP_ID" --identifier-uris "api://$APP_ID"
fi
SP="$(az ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null || az ad sp create --id "$APP_ID" --query id -o tsv)"
az ad sp update --id "$APP_ID" --set appRoleAssignmentRequired=true
# Operator tests use an Azure CLI token, as for the other registrations: a user_impersonation scope with the Azure CLI
# pre-authorized. The scope must exist before the pre-authorization can name it, hence two updates.
CLI=04b07795-8ddb-461a-bbee-02f9e1bf7b46
APP_GRAPH="https://graph.microsoft.com/v1.0/applications/$(az ad app show --id "$APP_ID" --query id -o tsv)"
SCOPE_ID="$(az ad app show --id "$APP_ID" --query "api.oauth2PermissionScopes[?value=='user_impersonation'].id | [0]" -o tsv)"
if [ -z "$SCOPE_ID" ]; then
  SCOPE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  az rest --method patch --url "$APP_GRAPH" --headers Content-Type=application/json --body "{\"api\":{\"oauth2PermissionScopes\":[{\"id\":\"$SCOPE_ID\",\"value\":\"user_impersonation\",\"type\":\"User\",\"isEnabled\":true,\"adminConsentDisplayName\":\"Use GeoBasin Explorer AI\",\"adminConsentDescription\":\"Lets the app sign the user in to GeoBasin Explorer AI.\",\"userConsentDisplayName\":\"Use GeoBasin Explorer AI\",\"userConsentDescription\":\"Lets the app sign you in to GeoBasin Explorer AI.\"}]}}"
fi
if [ -z "$(az ad app show --id "$APP_ID" --query "api.preAuthorizedApplications[?appId=='$CLI'].appId | [0]" -o tsv)" ]; then
  az rest --method patch --url "$APP_GRAPH" --headers Content-Type=application/json --body "{\"api\":{\"preAuthorizedApplications\":[{\"appId\":\"$CLI\",\"delegatedPermissionIds\":[\"$SCOPE_ID\"]}]}}"
fi
GRAPH="https://graph.microsoft.com/v1.0/servicePrincipals/$SP/appRoleAssignedTo"
assign() {  # <role value> <comma-separated object IDs>
  local role principal
  role="$(az ad app show --id "$APP_ID" --query "appRoles[?value=='$1'].id | [0]" -o tsv)"
  for principal in ${2//,/ }; do
    if [ -z "$(az rest --method get --url "$GRAPH" --query "value[?principalId=='$principal' && appRoleId=='$role'].id | [0]" -o tsv)" ]; then
      az rest --method post --url "$GRAPH" --body "{\"principalId\":\"$principal\",\"resourceId\":\"$SP\",\"appRoleId\":\"$role\"}" -o none
    fi
  done
}
assign GeoBasin.Tester "$USERS"
assign GeoBasin.Owner "$OWNERS"
echo "$APP_ID"
