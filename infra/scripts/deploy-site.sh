#!/usr/bin/env bash
# Builds and deploys the version 2 web app, gbx-site (infra/bicep/site.bicep).
#   infra/scripts/deploy-site.sh build           builds the app image with GBX_BRAND from this working tree, prints its tag
#   infra/scripts/deploy-site.sh deploy <tag>    deploys that tag; GBX_WHATIF=1 shows the changes instead
# Each deployment creates a new client secret on the app's own sign-in registration (site-signin.sh), hands it straight to
# the deployment without printing it, and removes the older ones; it makes a fresh run-ticket key the same way. Once the
# hosted agents exist (GBX_AGENT_IDENTITIES, recorded by deploy.sh hosted) it lets the app's agent identity call
# gbx-coscientist and gbx-copilot and nothing else (grant-agent-caller.sh), lets the API call them on a signed-in person's
# behalf so that the scientists ask Fabric IQ with that person's own permissions (grant-fabric-iq.sh), and, once the
# knowledge workspace exists, lets the app's Fabric identity read the knowledge graph (grant-fabric-reader.sh).
# Learn: https://learn.microsoft.com/azure/container-registry/container-registry-tutorial-quick-task
set -euo pipefail
. "$(dirname "$0")/lib.sh"
gbx_foundation
case "${1:-}" in
  build)
    TAG="$(gbx_api_version)-$(date -u +%Y%m%d%H%M)-$GBX_BRAND"
    (cd "$GBX_ROOT" && az acr build --subscription "$SUB" -r "$GBX_ACR_NAME" -t "gbx-api:$TAG" --build-arg "GBX_BRAND=$GBX_BRAND" \
      -f services/api/Dockerfile . --only-show-errors >&2)
    echo "$TAG"
    ;;
  deploy)
    TAG="${2:?usage: infra/scripts/deploy-site.sh deploy <tag>}"
    gbx_require GBX_SITE_URL GBX_SITE_APP_ID
    if [ "$(az acr repository show-tags --subscription "$SUB" -n "$GBX_ACR_NAME" --repository gbx-api --query "contains(@, '$TAG')" -o tsv)" != "true" ]; then
      echo "No image gbx-api:$TAG in $GBX_ACR_NAME; build one with infra/scripts/deploy-site.sh build" >&2; false
    fi
    export GBX_SITE_IMAGE="$GBX_ACR_LOGIN_SERVER/gbx-api:$TAG"
    export GBX_VERSION="${TAG%%-*}"
    export GBX_SITE_AUTH_CLIENT_ID="$GBX_SITE_APP_ID"
    export GBX_SITE_TOOL_CALLERS="${GBX_AGENT_IDENTITIES:-}"
    export GBX_SITE_AGENT_CLIENT_IDS="${GBX_AGENT_IDENTITIES:-}"
    export GBX_LIVE_PROJECT_ENDPOINT="${GBX_LIVE_PROJECT_ENDPOINT:-$GBX_FOUNDRY_ENDPOINT/api/projects/geobasin-runtime}"
    if ! gbx_agents 2>/dev/null; then export GBX_V2_PROJECT_ENDPOINT=""; fi
    # An Esri key already held by the running app carries over without being printed (esri-key.sh sets it).
    GBX_ESRI_API_KEY="$(az containerapp secret show --subscription "$SUB" -g "$APP_RG" -n gbx-site --secret-name esri-api-key --query value -o tsv 2>/dev/null || true)"
    GBX_SITE_RUN_TICKET_KEY="$(openssl rand -base64 32)"
    export GBX_ESRI_API_KEY GBX_SITE_RUN_TICKET_KEY
    OLD_KEYS="$(az ad app credential list --id "$GBX_SITE_APP_ID" --query "[].keyId" -o tsv)"
    NAME="easyauth-site-$(date -u +%Y%m%d%H%M)"
    END="$(date -u -v+180d +%Y-%m-%d 2>/dev/null || date -u -d '+180 days' +%Y-%m-%d)"
    GBX_SITE_AUTH_CLIENT_SECRET="$(az ad app credential reset --id "$GBX_SITE_APP_ID" --append --display-name "$NAME" --end-date "$END" --query password -o tsv 2>/dev/null)"
    export GBX_SITE_AUTH_CLIENT_SECRET
    cd "$GBX_INFRA/bicep"
    if [ -n "${GBX_WHATIF:-}" ]; then
      az deployment group what-if --subscription "$SUB" -g "$APP_RG" -f site.bicep -p site.bicepparam
    else
      OUT="$(az deployment group create --subscription "$SUB" -g "$APP_RG" -n gbx-site -f site.bicep -p site.bicepparam --query properties.outputs -o json)"
    fi
    unset GBX_SITE_AUTH_CLIENT_SECRET GBX_ESRI_API_KEY GBX_SITE_RUN_TICKET_KEY
    NEW_KEY="$(az ad app credential list --id "$GBX_SITE_APP_ID" --query "[?displayName=='$NAME'].keyId | [0]" -o tsv)"
    if [ -n "${GBX_WHATIF:-}" ]; then
      az ad app credential delete --id "$GBX_SITE_APP_ID" --key-id "$NEW_KEY"   # what-if only: drop the secret it created
      exit 0
    fi
    for k in $OLD_KEYS; do az ad app credential delete --id "$GBX_SITE_APP_ID" --key-id "$k"; done
    value() { python3 -c "import json,sys; print(json.load(sys.stdin)[sys.argv[1]]['value'])" "$1" <<<"$OUT"; }
    gbx_remember GBX_SITE_FQDN "$(value siteFqdn)"
    gbx_remember GBX_SITE_AGENTS_PRINCIPAL_ID "$(value agentsPrincipalId)"
    gbx_remember GBX_SITE_FABRIC_PRINCIPAL_ID "$(value fabricPrincipalId)"
    echo "gbx-site runs $TAG at $GBX_SITE_FQDN (public address $GBX_SITE_URL once the edge is deployed)."
    if [ -n "${GBX_AGENT_IDENTITIES:-}" ] && [ -n "${GBX_V2_PROJECT_ENDPOINT:-}" ]; then
      "$GBX_INFRA/scripts/grant-agent-caller.sh" "$GBX_SITE_AGENTS_PRINCIPAL_ID" gbx-coscientist gbx-copilot
      "$GBX_INFRA/scripts/grant-fabric-iq.sh" "$GBX_SITE_APP_ID" "$GBX_SITE_AGENTS_PRINCIPAL_ID"
    fi
    if [ -n "${GBX_FABRIC_WORKSPACE_ID:-}" ]; then
      "$GBX_INFRA/scripts/grant-fabric-reader.sh" "$GBX_SITE_FABRIC_PRINCIPAL_ID"
    fi
    echo "Sign-in secrets now: $(az ad app credential list --id "$GBX_SITE_APP_ID" --query "[].displayName" -o tsv | tr '\n' ' ')"
    ;;
  *)
    echo "usage: infra/scripts/deploy-site.sh build | deploy <tag>" >&2; false
    ;;
esac
