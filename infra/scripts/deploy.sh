#!/usr/bin/env bash
# Stands up GeoBasin Explorer AI version 2 in an Azure subscription, phase by phase (docs/DEPLOYMENT.md).
#   infra/scripts/deploy.sh <phase> [<phase> ...]
#   infra/scripts/deploy.sh all          foundation images platform [geo] [governance] agents fabric knowledge signin site
#                                        hosted edge, then lists the steps that need a person (geo and governance run
#                                        when GBX_DEPLOY_GEO or GBX_DEPLOY_GOVERNANCE is true)
# Phases, in the order a new tenant needs them:
#   foundation  resource groups, network, storage, Key Vault, Azure AI Foundry (version 1 runtime and build projects),
#               Azure AI Search, Document Intelligence, Azure Maps, monitoring, policy, private endpoints, Container Apps
#   images      builds gbx-api, gbx-pipeline, gbx-spatial and gbx-scanner in the registry (Azure Container Registry tasks)
#   platform    spatial service, ingestion and evaluation jobs, the live lane's jobs and the ClamAV scanner
#   geo         optional: the Planetary Computer Pro GeoCatalog and its Copernicus data, for the map's overlays
#   governance  optional: the Microsoft Purview account for catalog and lineage
#   agents      version 2 Foundry account in the standard agent setup: model router, validator and embedding deployments,
#               Cosmos DB, Storage and AI Search for agent data, the Fabric IQ connection once the ontology exists
#   fabric      Fabric capacity (unless GBX_FABRIC_CAPACITY_CREATE=false), the knowledge workspace, optional resume job
#   knowledge   the ingestion framework: data bundle, dataset folders, lakehouse tables, ontology, graph model; records
#               their IDs and connects the ontology to the agents' project through Fabric IQ
#   signin      the web app's Microsoft Entra registration, app roles and assignments
#   site        builds and deploys the web app (UI, API, tool server)
#   hosted      the scientists as Foundry hosted agents (gbx-copilot, gbx-coscientist) and the gbx-knowledge toolbox,
#               then redeploys the site so it trusts their identities and grants them what they need
#   edge        Azure DNS zone, Front Door Premium, WAF and the public host over Private Link
#   content     the two search indexes, then the source registry and every public source, landed inside the virtual
#               network (then a person lands the few browser-only sources and approves each extraction)
#   library     the library in OneLake (docs/LIBRARY_ONELAKE.md): workspace identity, trusted access, lakehouse shortcuts,
#               silver and gold notebooks, the OneLake files indexer; once a publication passes, the site reads from gold
#   smoke       checks the Foundry setup and the public site
# Settings come from infra/config/environment.env; discovered values go to infra/config/environment.generated.env.
# GBX_WHATIF=1 previews every template deployment instead of applying it.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
SCRIPTS="$GBX_INFRA/scripts"
BICEP="$GBX_INFRA/bicep"
VERB=(create); if [ -n "${GBX_WHATIF:-}" ]; then VERB=(what-if); fi

phase_foundation() {
  gbx_require GBX_OPERATOR_OBJECT_ID GBX_ALERT_EMAIL GBX_SITE_URL
  az deployment sub "${VERB[@]}" --subscription "$SUB" -l "$GBX_LOCATION" -n gbx-foundation \
    -f "$BICEP/main.bicep" -p "$BICEP/main.bicepparam" -o none
  if [ -z "${GBX_WHATIF:-}" ]; then gbx_foundation; echo "Foundation ready (suffix $GBX_SUFFIX)."; fi
}

phase_images() {
  gbx_remember GBX_RELEASE_TAG "$("$SCRIPTS/deploy-platform.sh" build)"
  echo "Images built: release $GBX_RELEASE_TAG."
}

phase_platform() {
  gbx_require GBX_RELEASE_TAG
  "$SCRIPTS/deploy-platform.sh" deploy "$GBX_RELEASE_TAG"
}

phase_geo() {
  gbx_foundation
  local location="${GBX_GEO_LOCATION:-northcentralus}" log
  az provider register --subscription "$SUB" --namespace Microsoft.Orbital --wait -o none
  az deployment sub "${VERB[@]}" --subscription "$SUB" -l "$location" -n gbx-geo -f "$BICEP/geo.bicep" -o none \
    -p sfx="$GBX_SUFFIX" location="$location" appLocation="$GBX_LOCATION"
  if [ -n "${GBX_WHATIF:-}" ]; then return; fi
  local out
  out="$(az deployment sub show --subscription "$SUB" -n gbx-geo --query properties.outputs -o json)"
  gbx_remember GBX_PC_IDENTITY_ID "$(_gbx_output "$out" identityId)"
  gbx_remember GBX_PC_IDENTITY_CLIENT_ID "$(_gbx_output "$out" identityClientId)"
  gbx_remember GBX_PC_CATALOG_URI "$(_gbx_output "$out" catalogUri)"
  # Copies the Copernicus DEM and Sentinel-2 items over the Cooper Basin from the open Planetary Computer and registers
  # one mosaic per collection, whose IDs the site's overlay relay needs.
  log="$(mktemp)"
  python3 "$SCRIPTS/planetary_load.py" 2>&1 | tee "$log"
  gbx_remember GBX_PC_SEARCHES "$(sed -n 's/^PC_SEARCHES value for .*: //p' "$log" | tail -1)"
  rm -f "$log"
  if [ -z "$GBX_PC_SEARCHES" ]; then echo "The GeoCatalog registered no mosaics; see the output above." >&2; return 1; fi
  echo "Planetary Computer overlays ready ($GBX_PC_SEARCHES). The next site deployment turns them on."
}

phase_governance() {
  gbx_foundation
  local location="${GBX_GOVERNANCE_LOCATION:-westus}"
  az deployment sub "${VERB[@]}" --subscription "$SUB" -l "$location" -n gbx-governance -f "$BICEP/governance.bicep" -o none \
    -p sfx="$GBX_SUFFIX" location="$location"
  if [ -n "${GBX_WHATIF:-}" ]; then return; fi
  echo "Microsoft Purview account pview-gbx-$GBX_SUFFIX is ready. For the live lane to record lineage in it, give the identity"
  echo "id-gbx-pipeline the Data Curator role on a Purview collection, set GBX_PURVIEW=true and GBX_PURVIEW_COLLECTION_ID"
  echo "in infra/config/environment.env, and rerun: infra/scripts/deploy.sh platform"
}

phase_agents() {
  gbx_require GBX_OPERATOR_OBJECT_ID
  az deployment sub "${VERB[@]}" --subscription "$AGENTS_SUB" -l "$GBX_LOCATION" -n gbx2-foundry \
    -f "$BICEP/agents/foundry.bicep" -p "$BICEP/agents/foundry.bicepparam" -o none
  if [ -z "${GBX_WHATIF:-}" ]; then gbx_agents; echo "Version 2 Foundry project: $GBX_V2_PROJECT_ENDPOINT"; fi
}

# GBX_FABRIC_ENABLED=false deploys without Microsoft Fabric (docs/DEPLOYMENT.md, Deploying without Fabric).
gbx_fabric_enabled() { [ "${GBX_FABRIC_ENABLED:-true}" != "false" ]; }
gbx_fabric_skipped() { echo "Skipped: GBX_FABRIC_ENABLED=false, so this deployment has no knowledge ontology, graph or OneLake library."; }

phase_fabric() {
  if ! gbx_fabric_enabled; then gbx_fabric_skipped; return 0; fi
  gbx_require GBX_FABRIC_CAPACITY_NAME
  if [ "${GBX_FABRIC_CAPACITY_CREATE:-true}" = "true" ]; then
    gbx_require GBX_FABRIC_ADMINS
    az deployment sub "${VERB[@]}" --subscription "$AGENTS_SUB" -l "$GBX_LOCATION" -n gbx2-fabric-capacity \
      -f "$BICEP/agents/fabric-capacity.bicep" -p "$BICEP/agents/fabric-capacity.bicepparam" -o none
  fi
  if [ "${GBX_FABRIC_RESUME:-false}" = "true" ]; then
    gbx_foundation
    az deployment sub "${VERB[@]}" --subscription "$AGENTS_SUB" -l "$GBX_LOCATION" -n gbx2-fabric-resume \
      -f "$BICEP/agents/fabric-resume.bicep" -p "$BICEP/agents/fabric-resume.bicepparam" -o none
  fi
  if [ -n "${GBX_WHATIF:-}" ]; then return; fi
  gbx_remember GBX_FABRIC_WORKSPACE_ID "$(python3 "$SCRIPTS/fabric_workspace.py" ensure)"
  echo "Fabric workspace: $GBX_FABRIC_WORKSPACE_ID"
}

phase_knowledge() {
  if ! gbx_fabric_enabled; then gbx_fabric_skipped; return 0; fi
  gbx_require GBX_FABRIC_WORKSPACE_ID
  gbx_foundation
  local fw="$GBX_ROOT/ingestion-framework" py
  python3 - "$fw" <<'PY'
import json, os, sys
from pathlib import Path
fw = Path(sys.argv[1])
cfg = json.loads((fw / "config/geobasin.example.json").read_text())
cfg["workspace_id"] = os.environ["GBX_FABRIC_WORKSPACE_ID"]
(fw / "config/geobasin.json").write_text(json.dumps(cfg, indent=2) + "\n")
foundry = json.loads((fw / "config/geobasin-foundry.example.json").read_text())
foundry.update(subscriptionId=os.environ["GBX_SUBSCRIPTION_ID"], resourceGroup="rg-geobasin-ai",
               account=os.environ["GBX_FOUNDRY_NAME"], project="geobasin-build")
(fw / "config/geobasin-foundry.json").write_text(json.dumps(foundry, indent=2) + "\n")
PY
  if [ ! -x "$fw/.venv/bin/python" ]; then
    python3 -m venv "$fw/.venv"
    "$fw/.venv/bin/pip" install --quiet -e "${fw}[delta]"
  fi
  py="$fw/.venv/bin/python"
  # The knowledge kit is generated by the app's own graph code, so the app's packages must be installed.
  if [ ! -d "$GBX_ROOT/app/node_modules" ]; then (cd "$GBX_ROOT/app" && npm ci --no-audit --no-fund); fi
  local bundle_args=(--out ../build/bundle)
  if [ -n "${GBX_WSM_CSV:-}" ]; then
    case "$GBX_WSM_CSV" in /*) ;; *) GBX_WSM_CSV="$GBX_ROOT/$GBX_WSM_CSV" ;; esac
    if [ -f "$GBX_WSM_CSV" ]; then
      bundle_args+=(--wsm "$GBX_WSM_CSV")
    else
      echo "GBX_WSM_CSV names $GBX_WSM_CSV, which isn't there yet; the knowledge model leaves the stress records out until it is."
    fi
  fi
  (cd "$fw" && "$py" tools/make_bundle.py "${bundle_args[@]}")
  # Once the site has published a library, its manifest adds the library's sources and documents to the knowledge model.
  if [ -n "${GBX_SITE_APP_ID:-}" ] && python3 "$SCRIPTS/live_content.py" manifest "$GBX_ROOT/build/live-manifest.json" 2>/dev/null; then
    export GBX_LIVE_MANIFEST="$GBX_ROOT/build/live-manifest.json"
  else
    echo "No published library manifest yet, so the knowledge model leaves the library out; rerun this phase after publishing."
  fi
  (cd "$fw" && "$py" -m producers --bundle ../build/bundle --out ../build/landing)
  # A graph model created through the REST API loads data only after someone has opened it once in the Fabric portal
  # (Microsoft Learn, Manage data in graph). Everything before the load is published by then, so on that one known stop the
  # phase records the items and lets the deployment go on; the graph's knowledge tools wait until the phase reruns.
  local log status=0
  log="$(mktemp)"
  (cd "$fw" && "$py" -m ontology_ingest --config config/geobasin.json run --mcp-smoke) 2>&1 | tee "$log" || status=$?
  if [ "$status" -ne 0 ]; then
    if grep -q "opened once in the graph model editor" "$log"; then
      gbx_remember GBX_GRAPH_FIRST_OPEN pending
    else
      rm -f "$log"
      return "$status"
    fi
  else
    gbx_remember GBX_GRAPH_FIRST_OPEN done
  fi
  rm -f "$log"
  local ontology graph
  ontology="$(python3 "$SCRIPTS/fabric_workspace.py" item Ontology "$(python3 -c "import json; print(json.load(open('$fw/config/geobasin.json'))['ontology_name'])")")"
  graph="$(python3 "$SCRIPTS/fabric_workspace.py" item GraphModel "$(python3 -c "import json; print(json.load(open('$fw/config/geobasin.json'))['graph_model_name'])")")"
  gbx_remember GBX_FABRIC_ONTOLOGY_ID "$ontology"
  gbx_remember GBX_FABRIC_GRAPH_MODEL_ID "$graph"
  gbx_remember GBX_FABRIC_IQ_ENDPOINT "https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/$GBX_FABRIC_WORKSPACE_ID/items/$ontology/ontologyEndpoint"
  echo "Ontology $ontology, graph model $graph."
  if [ "$GBX_GRAPH_FIRST_OPEN" = "pending" ]; then
    echo "The graph model is published but not loaded yet. Open it once in the Fabric portal, then run:"
    echo "  infra/scripts/deploy.sh knowledge"
    echo "Until then the ontology and Fabric IQ work, and the typed knowledge tools say the graph isn't connected."
  fi
  phase_agents   # adds the Fabric IQ connection to the agents' project now that the endpoint is known
}

phase_signin() {
  gbx_remember GBX_SITE_APP_ID "$("$SCRIPTS/site-signin.sh" | tail -1)"
  echo "Sign-in registration: $GBX_SITE_APP_ID"
}

phase_site() {
  if [ -z "${GBX_SITE_TAG:-}" ] || [ "${GBX_REBUILD_SITE:-}" = "1" ]; then
    gbx_remember GBX_SITE_TAG "$("$SCRIPTS/deploy-site.sh" build)"
  fi
  "$SCRIPTS/deploy-site.sh" deploy "$GBX_SITE_TAG"
}

phase_hosted() {
  gbx_require GBX_SITE_APP_ID
  if gbx_fabric_enabled; then gbx_require GBX_FABRIC_WORKSPACE_ID GBX_FABRIC_ONTOLOGY_ID; fi
  gbx_agents
  python3 "$GBX_ROOT/services/scientists/deploy_hosted.py"
  gbx_remember GBX_AGENT_IDENTITIES "$(python3 "$GBX_ROOT/services/scientists/deploy_hosted.py" --identities)"
  echo "Hosted agents' identities: $GBX_AGENT_IDENTITIES"
  GBX_REBUILD_SITE=0 phase_site   # the site now admits the agents and grants their access
}

phase_edge() {
  gbx_require GBX_DNS_ZONE GBX_SITE_HOST GBX_SITE_FQDN
  gbx_foundation
  if ! az network dns zone show --subscription "$SUB" -g "$EDGE_RG" -n "$GBX_DNS_ZONE" -o none 2>/dev/null; then
    az network dns zone create --subscription "$SUB" -g "$EDGE_RG" -n "$GBX_DNS_ZONE" -o none
  fi
  echo "Delegate $GBX_DNS_ZONE to these name servers if you haven't: $(az network dns zone show --subscription "$SUB" -g "$EDGE_RG" -n "$GBX_DNS_ZONE" --query nameServers -o tsv | tr '\n' ' ')"
  az deployment group "${VERB[@]}" --subscription "$SUB" -g "$EDGE_RG" -n gbx-edge \
    -f "$BICEP/edge.bicep" -p "$BICEP/edge.bicepparam" -o none
  if [ "${GBX_EDGE_CUTOVER:-false}" != "true" ]; then
    echo "Next (docs/DEPLOYMENT.md, Edge cut-over): wait for both domains to validate, approve Front Door's Private Link connection"
    echo "on the Container Apps environment, then set GBX_EDGE_CUTOVER=true and rerun this phase to point DNS at Front Door."
  fi
}

phase_content() {
  gbx_require GBX_LIVE_SOURCES
  gbx_foundation
  # Azure AI Search and Foundry take Entra-authenticated calls on their public endpoints, so the two indexes are built here
  # with the operator's roles (modules/roles-ai.bicep). The API's build bundles the app's library code, so it needs the
  # app's packages as well as its own.
  export STORAGE_ACCOUNT="$GBX_STORAGE_ACCOUNT" SEARCH_ENDPOINT="$GBX_SEARCH_ENDPOINT" FOUNDRY_ENDPOINT="$GBX_FOUNDRY_ENDPOINT" \
    DOCINTEL_ENDPOINT="$GBX_DOCINTEL_ENDPOINT"
  (cd "$GBX_ROOT/app" && npm ci --no-audit --no-fund)
  (cd "$GBX_ROOT/services/api" && npm ci --no-audit --no-fund && npm run build \
    && node dist/scripts/live-bootstrap.mjs --create-index \
    && node dist/scripts/build-index.mjs)
  echo "The evidence index (gbx-evidence-v2) and the packaged reference index (gbx-passages) are ready."
  # The source registry and the landed files live in private storage, so that work runs inside the virtual network as
  # executions of the gbx-connect job. A source that fails is reported at the end instead of stopping the others.
  local status=0
  python3 "$SCRIPTS/live_content.py" run || status=$?
  echo "Next: land the sources listed above by hand, then review and approve each extraction in the app as a GeoBasin owner;"
  echo "approval publishes it. Then release the serving agent (services/api/src/live/README.md, Releasing the serving agent),"
  echo "set GBX_LIVE_AGENT_NAME and GBX_LIVE_AGENT_VERSION in infra/config/environment.env, and rerun:"
  echo "  infra/scripts/deploy.sh platform site knowledge"
  return "$status"
}

phase_library() {
  if ! gbx_fabric_enabled; then gbx_fabric_skipped; return 0; fi
  gbx_require GBX_TENANT_ID GBX_FABRIC_WORKSPACE_ID
  gbx_foundation
  local fw="$GBX_ROOT/ingestion-framework" py=python3 status=0
  if [ -x "$fw/.venv/bin/python" ]; then py="$fw/.venv/bin/python"; fi
  "$py" "$SCRIPTS/fabric_library.py" setup
  "$py" "$SCRIPTS/fabric_library.py" deploy
  "$py" "$SCRIPTS/fabric_library.py" search
  "$py" "$SCRIPTS/fabric_library.py" run || status=$?
  if [ "$status" -eq 3 ]; then
    echo "The library is wired into OneLake. Rerun this phase after approving the first source to publish it from gold."
    return 0
  fi
  if [ "$status" -ne 0 ]; then return "$status"; fi
  if [ "${GBX_V2_LIBRARY_INDEX:-}" != "gbx-evidence-onelake" ]; then
    gbx_remember GBX_V2_LIBRARY_INDEX gbx-evidence-onelake
    GBX_REBUILD_SITE=0 phase_site   # the site now reads live passages from gold whenever gold covers the publication
  fi
}

phase_smoke() {
  gbx_agents
  # The public site first, so its result shows even when the Foundry checks stop early.
  if [ -n "${GBX_SITE_URL:-}" ]; then
    curl -sf "$GBX_SITE_URL/api/health" >/dev/null && echo "$GBX_SITE_URL/api/health answers." \
      || echo "$GBX_SITE_URL/api/health does not answer yet (edge cut-over pending?)." >&2
  fi
  # Its last check reads the agents' Cosmos DB, which a network security perimeter closes to everyone else; it passes
  # only while GBX_OPERATOR_CIDRS admits your public address (docs/DEPLOYMENT.md, The Bicep path).
  python3 "$SCRIPTS/foundry_smoke.py"
}

phase_summary() {
  echo
  echo "== What still needs a person"
  if [ "${GBX_EDGE_CUTOVER:-false}" != "true" ]; then
    echo "- Edge: delegate ${GBX_DNS_ZONE:-your DNS zone}, wait until both domains validate in Front Door, approve Front Door's Private Link"
    echo "  connection on the Container Apps environment, set GBX_EDGE_CUTOVER=true and run: infra/scripts/deploy.sh edge"
  fi
  if [ "${GBX_GRAPH_FIRST_OPEN:-}" = "pending" ]; then
    echo "- Knowledge graph: open the graph model once in the Fabric portal, then run: infra/scripts/deploy.sh knowledge"
  fi
  echo "- Library: once the site answers at ${GBX_SITE_URL:-your site address}, run: infra/scripts/deploy.sh content"
  echo "  (docs/DEPLOYMENT.md, Content and expert review), and after approving sources: infra/scripts/deploy.sh library"
}

if [ "$#" -eq 0 ]; then sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2; fi
ALL=0
if [ "$1" = "all" ]; then
  ALL=1
  set -- foundation images platform
  if [ "${GBX_DEPLOY_GEO:-false}" = "true" ]; then set -- "$@" geo; fi
  if [ "${GBX_DEPLOY_GOVERNANCE:-false}" = "true" ]; then set -- "$@" governance; fi
  set -- "$@" agents
  if gbx_fabric_enabled; then set -- "$@" fabric knowledge; fi
  set -- "$@" signin site hosted edge
fi
for p in "$@"; do
  case "$p" in
    foundation|images|platform|geo|governance|agents|fabric|knowledge|signin|site|hosted|edge|content|library|smoke) ;;
    *) echo "Unknown phase $p. Run infra/scripts/deploy.sh without arguments for the list." >&2; exit 2 ;;
  esac
done
az account set --subscription "$SUB"
for p in "$@"; do echo "== $p"; "phase_$p"; done
if [ "$ALL" = 1 ] && [ -z "${GBX_WHATIF:-}" ]; then phase_summary; fi
