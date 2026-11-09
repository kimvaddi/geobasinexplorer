"""Finds or creates the Fabric workspace for the knowledge ontology, and looks up items in it.

    python3 infra/scripts/fabric_workspace.py ensure                 # prints the workspace ID, creating the workspace on
                                                                    # the capacity when none of that name exists
    python3 infra/scripts/fabric_workspace.py item <type> <name>     # prints the ID of an item (Ontology, GraphModel,
                                                                    # Lakehouse ...) in that workspace, or nothing

It reads GBX_FABRIC_WORKSPACE_NAME, GBX_FABRIC_CAPACITY_NAME and, when set, GBX_FABRIC_WORKSPACE_ID from the environment
(infra/scripts/lib.sh exports infra/config/environment.env). It uses the Fabric REST API with the Azure CLI sign-in, which
must be a capacity administrator or contributor to assign the workspace.
Learn: https://learn.microsoft.com/rest/api/fabric/core/capacities/list-capacities
       https://learn.microsoft.com/rest/api/fabric/core/workspaces/create-workspace
       https://learn.microsoft.com/rest/api/fabric/core/workspaces/assign-to-capacity
       https://learn.microsoft.com/rest/api/fabric/core/items/list-items
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

FABRIC = "https://api.fabric.microsoft.com/v1"


def token() -> str:
    return subprocess.check_output(["az", "account", "get-access-token", "--resource", "https://api.fabric.microsoft.com",
                                    "--query", "accessToken", "-o", "tsv"], text=True).strip()


def call(method: str, url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} failed with {e.code}: {e.read().decode(errors='replace')[:400]}")


def listing(url: str) -> list[dict]:
    items: list[dict] = []
    while url:
        page = call("GET", url)
        items += page.get("value", [])
        url = page.get("continuationUri") or ""
    return items


def capacity_id(name: str) -> str:
    for c in listing(f"{FABRIC}/capacities"):
        if c.get("displayName", "").lower() == name.lower():
            return c["id"]
    sys.exit(f"No Fabric capacity named {name} is visible to this sign-in. Add it as a capacity administrator (GBX_FABRIC_ADMINS).")


def ensure() -> str:
    name = os.environ.get("GBX_FABRIC_WORKSPACE_NAME", "GeoBasin Knowledge")
    wanted = os.environ.get("GBX_FABRIC_WORKSPACE_ID", "")
    workspaces = listing(f"{FABRIC}/workspaces")
    found = next((w for w in workspaces if (wanted and w["id"] == wanted) or (not wanted and w.get("displayName") == name)), None)
    # A workspace someone else already placed on a capacity needs nothing more. This is also how a deployer who can't
    # administer the capacity proceeds, such as a B2B guest, whom Fabric never admits as a capacity administrator.
    if wanted and found and found.get("capacityId"):
        return found["id"]
    capacity = capacity_id(os.environ["GBX_FABRIC_CAPACITY_NAME"])
    if not found:
        if wanted:
            sys.exit(f"No workspace {wanted} is visible to this sign-in.")
        found = call("POST", f"{FABRIC}/workspaces", {"displayName": name, "capacityId": capacity,
                                                       "description": "GeoBasin Explorer AI knowledge ontology, graph model and ingestion pipeline."})
        print(f"Created the Fabric workspace {name}.", file=sys.stderr)
    elif found.get("capacityId") != capacity:
        call("POST", f"{FABRIC}/workspaces/{found['id']}/assignToCapacity", {"capacityId": capacity})
        print(f"Assigned the workspace {found.get('displayName')} to the capacity.", file=sys.stderr)
    return found["id"]


def item(kind: str, name: str) -> str:
    workspace = os.environ["GBX_FABRIC_WORKSPACE_ID"]
    query = urllib.parse.urlencode({"type": kind})
    return next((i["id"] for i in listing(f"{FABRIC}/workspaces/{workspace}/items?{query}") if i.get("displayName") == name), "")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("ensure", "item") or (sys.argv[1] == "item" and len(sys.argv) != 4):
        sys.exit(__doc__)
    TOKEN = token()
    print(ensure() if sys.argv[1] == "ensure" else item(sys.argv[2], sys.argv[3]))
