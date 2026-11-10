#!/usr/bin/env bash
# Lets one identity read GeoBasin's Fabric knowledge graph for the scientists' knowledge tools (docs/FOUNDRY_AGENTS.md,
# Tools; services/api/src/v2/knowledge.ts), and nothing more. Three things must hold, and this script makes each one true:
#  1. Fabric admits service principals and managed identities to APIs protected by its permission model through the
#     tenant setting "Service principals can call Fabric public APIs" (ServicePrincipalAccessPermissionAPIs). The script
#     changes no tenant setting: it checks that the setting admits the identity and stops with an explanation if not. The
#     separate setting "Service principals can create workspaces, connections, and deployment pipelines"
#     (ServicePrincipalAccessGlobalAPIs) isn't needed and is left alone.
#  2. Execute Query needs the Viewer role on the workspace, so the identity holds exactly Viewer, lowered if it holds more.
#  3. A graph shows a caller only the node types whose source tables the caller may read, and GeoBasin's lakehouse has
#     OneLake security switched on, with a DefaultReader role that admits only identities holding ReadAll. A Viewer
#     doesn't, so the graph answers it with GQL status 42000 ("you don't have access to any matching node types due to
#     security configuration enforcement"), which 8 November 2026 showed. The identity therefore gets its own OneLake
#     security role, GeoBasinGraphReaders, with Read on exactly the tables the graph model reads, taken from the graph's
#     definition on every run, so a graph republished to a new schema stays readable. OneLake applies a role change in
#     about five minutes.
# It needs an Azure CLI sign-in that may read the tenant settings (a Fabric administrator) and manage the workspace and
# the lakehouse's OneLake security (a workspace Admin). Safe to rerun.
#   infra/scripts/grant-fabric-reader.sh <principal-object-id>
# Learn: https://learn.microsoft.com/fabric/admin/service-admin-portal-developer#service-principals-can-call-fabric-public-apis
#        https://learn.microsoft.com/rest/api/fabric/graphmodel/items/execute-query(beta)
#        https://learn.microsoft.com/fabric/graph/share-graph-manage-permissions#underlying-data-access
#        https://learn.microsoft.com/fabric/onelake/security/data-access-control-model#latencies
#        https://learn.microsoft.com/rest/api/fabric/core/onelake-data-access-security/create-or-update-data-access-roles
set -euo pipefail
PRINCIPAL="${1:?usage: infra/scripts/grant-fabric-reader.sh <principal-object-id>}"
cd "$(dirname "$0")/../.."
TENANT="$(az account show --query tenantId -o tsv)"
python3 - "$PRINCIPAL" "$TENANT" ingestion-framework/config/geobasin.json <<'PY'
import base64, json, subprocess, sys, time, urllib.error, urllib.request
principal, tenant, config = sys.argv[1:4]
conf = json.load(open(config))
workspace, graph_name = conf["workspace_id"], conf["graph_model_name"]
lakehouse = conf.get("lakehouse_id", "")
F = "https://api.fabric.microsoft.com"
SETTING, ROLE = "ServicePrincipalAccessPermissionAPIs", "GeoBasinGraphReaders"
token = subprocess.check_output(["az", "account", "get-access-token", "--resource", F, "--query", "accessToken", "-o", "tsv"], text=True).strip()
def call(method, url, body=None, headers=None):
    req = urllib.request.Request(url if url.startswith("https://") else F + url, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: raw = r.read(); return r.status, r.headers, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e: raw = e.read(); return e.code, e.headers, json.loads(raw) if raw else {}
def finished(s, h, o):
    while s == 202 and h.get("Location"):
        loc = h["Location"]
        time.sleep(int(h.get("Retry-After") or 2))
        s, h, o = call("GET", loc)
        if s == 200 and o.get("status") == "Succeeded": return call("GET", loc.rstrip("/") + "/result")
        if s == 200 and o.get("status") in ("NotStarted", "Running"): s = 202
    return s, h, o
def member_of(groups):
    out = subprocess.check_output(["az", "rest", "--method", "POST", "--url",
                                   f"https://graph.microsoft.com/v1.0/directoryObjects/{principal}/checkMemberGroups",
                                   "--body", json.dumps({"groupIds": groups}), "--query", "value", "-o", "json"], text=True)
    return bool(json.loads(out))
# The configuration names the lakehouse by ID or, as a new deployment writes it, by name.
if not lakehouse:
    s, _, items = call("GET", f"/v1/workspaces/{workspace}/lakehouses")
    if s != 200: sys.exit(f"The workspace's lakehouses could not be listed ({s}): {items}")
    lakehouse = next((i["id"] for i in items.get("value", []) if i.get("displayName") == conf.get("lakehouse_name")), "")
    if not lakehouse: sys.exit(f"No lakehouse named {conf.get('lakehouse_name')} in the workspace; run the knowledge phase first.")

# 1. The tenant setting admits the identity.
s, _, settings = call("GET", "/v1/admin/tenantsettings")
if s != 200: sys.exit(f"The tenant settings could not be read ({s}); a Fabric administrator must run this script.")
setting = next(t for t in settings["tenantSettings"] if t["settingName"] == SETTING)
title = setting.get("title", SETTING)
allowed, excluded = setting.get("enabledSecurityGroups") or [], setting.get("excludedSecurityGroups") or []
if not setting["enabled"]:
    sys.exit(f"\"{title}\" is off in this tenant. A Fabric administrator must turn it on for a security group that contains {principal}.")
if allowed and not member_of([g["graphId"] for g in allowed]):
    sys.exit(f"\"{title}\" admits only {', '.join(g['name'] for g in allowed)}. Add {principal} to one of them, then rerun.")
if excluded and member_of([g["graphId"] for g in excluded]):
    sys.exit(f"\"{title}\" excludes {', '.join(g['name'] for g in excluded)}, and {principal} belongs to one of them.")
print(f"\"{title}\" admits {principal}" + ("." if allowed else ", because the setting applies to the whole organization."))

# 2. Exactly Viewer on the workspace.
path, held = f"/v1/workspaces/{workspace}/roleAssignments", None
while path and not held:
    s, _, page = call("GET", path)
    if s != 200: sys.exit(f"The workspace's role assignments could not be read ({s}).")
    held = next((r["role"] for r in page.get("value", []) if r.get("principal", {}).get("id") == principal), None)
    path = page.get("continuationUri")
if held == "Viewer":
    print(f"{principal} holds the Viewer role on the GeoBasin workspace.")
elif held:
    s, _, out = call("PATCH", f"/v1/workspaces/{workspace}/roleAssignments/{principal}", {"role": "Viewer"})
    if s != 200: sys.exit(f"The {held} role could not be lowered to Viewer ({s}): {json.dumps(out)[:300]}")
    print(f"{principal} held the {held} role on the GeoBasin workspace and now holds Viewer.")
else:
    s, _, out = call("POST", f"/v1/workspaces/{workspace}/roleAssignments",
                     {"principal": {"id": principal, "type": "ServicePrincipal"}, "role": "Viewer"})
    if s not in (200, 201): sys.exit(f"The Viewer role could not be assigned ({s}): {json.dumps(out)[:300]}")
    print(f"{principal} is now a Viewer of the GeoBasin workspace.")

# 3. Read on the graph's source tables, through a OneLake security role of its own.
s, _, models = call("GET", f"/v1/workspaces/{workspace}/graphModels")
graph = next((m["id"] for m in models.get("value", []) if m["displayName"] == graph_name), None)
if not graph: sys.exit(f"The graph model {graph_name} wasn't found in the workspace ({s}).")
s, _, out = finished(*call("POST", f"/v1/workspaces/{workspace}/graphModels/{graph}/getDefinition"))
part = next((p for p in out.get("definition", {}).get("parts", []) if p["path"] == "dataSources.json"), None)
if s != 200 or not part: sys.exit(f"The definition of {graph_name} could not be read ({s}).")
sources = json.loads(base64.b64decode(part["payload"]))
refs = {r["name"]: r["item"] for r in sources.get("itemReferences", [])}
tables = set()
for d in sources.get("dataSources", []):
    item = refs.get(d["properties"]["referenceName"], {})
    if item.get("workspaceId") != workspace or item.get("itemId") != lakehouse:
        sys.exit(f"{graph_name} reads {d['name']} from an item other than the GeoBasin lakehouse; grant that item by hand.")
    tables.add("/" + d["properties"]["path"].strip("/"))
s, h, current = call("GET", f"/v1/workspaces/{workspace}/items/{lakehouse}/dataAccessRoles")
if s != 200: sys.exit(f"The lakehouse's OneLake security roles could not be read ({s}): {json.dumps(current)[:300]}")
roles = [{k: v for k, v in r.items() if k != "etag"} for r in current.get("value", [])]
mine = next((r for r in roles if r["name"] == ROLE), None)
members = (mine or {}).get("members", {}).get("microsoftEntraMembers", [])
granted = {p for r in (mine or {}).get("decisionRules", []) for a in r.get("permission", []) if a["attributeName"] == "Path" for p in a["attributeValueIncludedIn"]}
if mine and granted == tables and any(m["objectId"] == principal for m in members):
    print(f"{principal} already reads the {len(tables)} tables of {graph_name} through the OneLake security role {ROLE}.")
    sys.exit(0)
role = {**({"id": mine["id"], "kind": mine.get("kind", "Policy")} if mine else {}), "name": ROLE,
        "decisionRules": [{"effect": "Permit", "permission": [{"attributeName": "Path", "attributeValueIncludedIn": sorted(tables)},
                                                              {"attributeName": "Action", "attributeValueIncludedIn": ["Read"]}]}],
        "members": {"microsoftEntraMembers": [m for m in members if m["objectId"] != principal] + [{"tenantId": tenant, "objectId": principal}]}}
body = {"value": [r for r in roles if r["name"] != ROLE] + [role]}
guard = {"If-Match": h["ETag"]} if h.get("ETag") else {}
for dry in ("true", "false"):
    s, _, out = call("PUT", f"/v1/workspaces/{workspace}/items/{lakehouse}/dataAccessRoles?dryRun={dry}", body, guard)
    if s != 200: sys.exit(f"The OneLake security role {ROLE} could not be {'checked' if dry == 'true' else 'saved'} ({s}): {json.dumps(out)[:400]}")
print(f"{principal} now reads the {len(tables)} tables of {graph_name} through the OneLake security role {ROLE}; OneLake applies it in about five minutes.")
PY
