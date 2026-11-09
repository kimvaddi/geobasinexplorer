#!/usr/bin/env bash
# Builds the container images and deploys the platform workloads that the web app relies on.
#   infra/scripts/deploy-platform.sh build          builds gbx-api, gbx-pipeline, gbx-spatial and gbx-scanner in the
#                                                   registry with Azure Container Registry tasks and prints the release tag
#   infra/scripts/deploy-platform.sh deploy <tag>   deploys apps.bicep (spatial service, ingestion and evaluation jobs),
#                                                   live.bicep (the live lane's connect and process jobs) and pipeline.bicep
#                                                   (the ClamAV scanner); GBX_WHATIF=1 shows the changes instead
# The web app is deployed separately (deploy-site.sh), because it also needs its sign-in registration.
# Learn: https://learn.microsoft.com/azure/container-registry/container-registry-tutorial-quick-task
set -euo pipefail
. "$(dirname "$0")/lib.sh"
gbx_foundation
case "${1:-}" in
  build)
    TAG="$(gbx_api_version)-$(date -u +%Y%m%d%H%M)"
    acr() { az acr build --subscription "$SUB" -r "$GBX_ACR_NAME" --only-show-errors "$@" >&2; }
    (cd "$GBX_ROOT" && acr -t "gbx-api:$TAG-$GBX_BRAND" --build-arg "GBX_BRAND=$GBX_BRAND" -f services/api/Dockerfile .)
    (cd "$GBX_ROOT" && acr -t "gbx-pipeline:$TAG" -f services/api/Dockerfile --target pipeline .)
    (cd "$GBX_ROOT" && acr -t "gbx-spatial:$TAG" -f services/spatial/Dockerfile .)
    (cd "$GBX_ROOT/services/scanner" && acr -t "gbx-scanner:$TAG" -f Dockerfile .)
    echo "$TAG"
    ;;
  deploy)
    TAG="${2:?usage: infra/scripts/deploy-platform.sh deploy <tag printed by build>}"
    export GBX_IMAGE="$GBX_ACR_LOGIN_SERVER/gbx-api:$TAG-$GBX_BRAND"
    export GBX_SPATIAL_IMAGE="$GBX_ACR_LOGIN_SERVER/gbx-spatial:$TAG"
    export GBX_VERSION="${TAG%%-*}"
    export GBX_LIVE_PROJECT_ENDPOINT="${GBX_LIVE_PROJECT_ENDPOINT:-$GBX_FOUNDRY_ENDPOINT/api/projects/geobasin-runtime}"
    cd "$GBX_INFRA/bicep"
    verb=(create); if [ -n "${GBX_WHATIF:-}" ]; then verb=(what-if); fi
    az deployment group "${verb[@]}" --subscription "$SUB" -g "$APP_RG" -n gbx-apps -f apps.bicep -p apps.bicepparam -o none
    az deployment group "${verb[@]}" --subscription "$SUB" -g "$APP_RG" -n gbx-live -f live.bicep -o none \
      -p sfx="$GBX_SUFFIX" pipelineImageTag="$TAG" appInsightsConnectionString="$GBX_APPI_CONNECTION_STRING" \
         liveScan="${GBX_LIVE_SCAN:-true}" purview="${GBX_PURVIEW:-false}" purviewCollectionId="${GBX_PURVIEW_COLLECTION_ID:-}" \
         tokensPerDay="${GBX_TOKENS_PER_DAY:-50000000}" aiEnabled="${GBX_AI_ENABLED:-true}"
    az deployment group "${verb[@]}" --subscription "$SUB" -g "$APP_RG" -n gbx-pipeline -f pipeline.bicep -o none \
      -p sfx="$GBX_SUFFIX" imageTag="$TAG"
    gbx_remember GBX_RELEASE_TAG "$TAG"
    echo "Platform workloads deployed with release $TAG."
    ;;
  *)
    echo "usage: infra/scripts/deploy-platform.sh build | deploy <tag>" >&2; false
    ;;
esac
