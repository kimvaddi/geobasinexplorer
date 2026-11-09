"""Deploys the scientists to Foundry as two hosted agents from source code, gbx-copilot and gbx-coscientist.

    python3 deploy_hosted.py                 # package, create or update both agents, wait until active, show their identities
    python3 deploy_hosted.py --show          # only show the agents, their versions and their identities
    python3 deploy_hosted.py --identities    # print the agents' identity object IDs, comma-separated (used by infra/scripts/deploy.sh)

It follows Microsoft Learn's REST path for source-code deployment (Deploy a hosted agent from source code): a flat zip of
main.py, requirements.txt and the package, built remotely on Python 3.13, serving the Responses protocol. A new version
is minted only when the zip or the definition changes. Run it with an Azure CLI sign-in that holds Foundry User or Foundry
Project Manager on the version 2 project. Needs only Python and curl.

Before the agents it makes sure the toolbox gbx-knowledge holds the Fabric IQ tool on the project connection
fabriciq-geobasin-knowledge (infra/bicep/agents/modules/foundry-account.bicep), and hands its MCP endpoint to both agents,
through which the specialists ask the knowledge ontology as the signed-in person (Microsoft Learn, Connect agents to
Microsoft Fabric with Fabric IQ, hosted agents).
"""
import argparse
import hashlib
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import zipfile

HERE = pathlib.Path(__file__).resolve().parent


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"Set {name} first (infra/config/environment.example.env lists every setting).")
    return value


# Every deployment supplies its own values (infra/config/environment.env, exported by infra/scripts/deploy.sh):
#   GBX_V2_PROJECT_ENDPOINT  the version 2 Foundry project, https://<account>.services.ai.azure.com/api/projects/<project>
#   GBX_SITE_URL             the web app's public address; its tool server answers at /api/mcp
#   GBX_SITE_APP_ID          the web app's Entra sign-in registration; the agents ask Entra for a token to api://<id>
#   GBX_FABRIC_WORKSPACE_ID and GBX_FABRIC_ONTOLOGY_ID  the Fabric workspace and the ontology that Fabric IQ answers from
PROJECT = os.environ.get("GBX_V2_PROJECT_ENDPOINT", "")
API = "api-version=v1"
TOOL_SERVER = os.environ.get("GBX_SITE_URL", "").rstrip("/") + "/api/mcp"
TOOL_AUDIENCE = f"api://{os.environ.get('GBX_SITE_APP_ID', '')}"
AGENTS = {"gbx-copilot": "copilot", "gbx-coscientist": "coscientist"}
TOOLBOX = "gbx-knowledge"
FABRIC_IQ_TOOL = {"type": "fabric_iq_preview", "project_connection_id": "fabriciq-geobasin-knowledge", "server_label": "geobasin-ontology",
                  "server_url": "https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/{workspace}/items/{ontology}/ontologyEndpoint"
                  .format(workspace=os.environ.get("GBX_FABRIC_WORKSPACE_ID", ""), ontology=os.environ.get("GBX_FABRIC_ONTOLOGY_ID", ""))}


# GBX_FABRIC_ENABLED=false deploys the scientists without the knowledge ontology: no toolbox, so they answer from the
# library's passages and say that structured knowledge is unavailable (docs/DEPLOYMENT.md, Deploying without Fabric).
FABRIC_ENABLED = os.environ.get("GBX_FABRIC_ENABLED", "true").strip().lower() != "false"


def check_settings() -> None:
    names = ("GBX_V2_PROJECT_ENDPOINT", "GBX_SITE_URL", "GBX_SITE_APP_ID")
    for name in names + (("GBX_FABRIC_WORKSPACE_ID", "GBX_FABRIC_ONTOLOGY_ID") if FABRIC_ENABLED else ()):
        _required(name)


def token() -> str:
    return subprocess.check_output(["az", "account", "get-access-token", "--resource", "https://ai.azure.com", "--query", "accessToken", "-o", "tsv"], text=True).strip()


def curl(*args: str) -> tuple[int, dict]:
    out = subprocess.run(["curl", "-s", "-w", "\n%{http_code}", *args], capture_output=True, text=True, check=True).stdout
    body, _, status = out.rpartition("\n")
    try:
        return int(status), json.loads(body) if body.strip() else {}
    except ValueError:
        return int(status), {"raw": body[:500]}


def package() -> bytes:
    """A flat zip: main.py, requirements.txt and every module of gbx_scientists, in a fixed order with fixed timestamps,
    so unchanged code gives the same SHA-256 and the service mints no new version. Entries carry the regular-file and
    directory type bits and the folders have entries of their own, as ordinary zip tools write them: the service's build
    found no requirements.txt in a zip whose entries had permission bits only (8 November 2026)."""
    files = [HERE / "main.py", HERE / "requirements.txt", *sorted((HERE / "gbx_scientists").rglob("*.py"))]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        folders = sorted({p for f in files for p in f.relative_to(HERE).parents if str(p) != "."}, key=str)
        for folder in folders:
            info = zipfile.ZipInfo(f"{folder}/", date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = (0o40755 << 16) | 0x10
            z.writestr(info, b"")
        for f in files:
            info = zipfile.ZipInfo(str(f.relative_to(HERE)), date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            z.writestr(info, f.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    return buffer.getvalue()


def ensure_toolbox(t: str) -> str:
    """The toolbox's newest version if it already holds exactly the Fabric IQ tool, otherwise a new version; returns its MCP endpoint."""
    status, box = curl("-H", f"Authorization: Bearer {t}", f"{PROJECT}/toolboxes/{TOOLBOX}?{API}")
    latest = (box.get("versions") or {}).get("latest") or {} if status == 200 else {}
    version = latest.get("version") if latest.get("tools") == [FABRIC_IQ_TOOL] else None
    if not version:
        body = {"description": "GeoBasin's knowledge ontology through Fabric IQ, asked as the signed-in person", "tools": [FABRIC_IQ_TOOL]}
        status, made = curl("-X", "POST", f"{PROJECT}/toolboxes/{TOOLBOX}/versions?{API}", "-H", f"Authorization: Bearer {t}", "-H", "Content-Type: application/json", "-d", json.dumps(body))
        if status not in (200, 201):
            sys.exit(f"{TOOLBOX}: toolbox version refused ({status}): {json.dumps(made)[:600]}")
        version = made.get("version")
        print(f"{TOOLBOX}: toolbox version {version} created")
    return f"{PROJECT}/toolboxes/{TOOLBOX}/versions/{version}/mcp?{API}"


def definition(name: str, mode: str, toolbox_url: str = "") -> dict:
    return {
        "description": f"GeoBasin Explorer AI version 2 scientists ({mode}): lead, specialists, critic and validator as one Agent Framework workflow.",
        "metadata": {"workload": "geobasin-explorer-ai", "version": "2", "mode": mode},
        "definition": {
            "kind": "hosted",
            "protocol_versions": [{"protocol": "responses", "version": "2.0.0"}],
            "cpu": "1", "memory": "2Gi",
            # A person's sandbox stays warm for 30 minutes after their last request, so their next question skips the
            # cold start the app avoids by naming their session again (services/api/src/v2/cosci.ts SESSION_WARM_MS).
            "session_configuration": {"idle_timeout_seconds": 1800},
            "code_configuration": {"runtime": "python_3_13", "entry_point": ["python", "main.py"], "dependency_resolution": "remote_build"},
            "environment_variables": {
                "GBX_SCIENTIST_MODE": mode, "GBX_TOOL_SERVER_URL": TOOL_SERVER, "GBX_TOOL_AUDIENCE": TOOL_AUDIENCE,
                "GBX_ROUTER_DEPLOYMENT": "gbx2-router", "GBX_VALIDATOR_DEPLOYMENT": "gbx2-validator", "PYTHONNOUSERSITE": "1",
                # Empty keeps the specialists on gbx2-router; naming another router deployment here when deploying tries it
                # for them alone. A Cost-mode router was tried this way and not adopted (docs/FOUNDRY_AGENTS.md).
                "GBX_SPECIALIST_DEPLOYMENT": os.environ.get("GBX_SPECIALIST_DEPLOYMENT", ""),
                # Fabric IQ for runs the app starts as the person; the typed knowledge tools stay as the fallback.
                "GBX_TOOLBOX_URL": toolbox_url,
                # How long a Fabric IQ question may take before the typed tools stand in; empty keeps the default 75 s.
                "GBX_FABRIC_IQ_SECONDS": os.environ.get("GBX_FABRIC_IQ_SECONDS", ""),
            },
        },
    }


def show(name: str, t: str) -> dict:
    status, agent = curl("-H", f"Authorization: Bearer {t}", f"{PROJECT}/agents/{name}?{API}")
    if status != 200:
        print(f"{name}: not found ({status})")
        return {}
    latest = agent.get("versions", {}).get("latest", {})
    print(json.dumps({"name": name, "version": latest.get("version"), "status": latest.get("status"),
                      "identity": {k: v for k, v in agent.items() if "identity" in k.lower()} or {k: v for k, v in latest.items() if "identity" in k.lower()}}, indent=2))
    return agent


def identity_ids(agent: dict) -> list[str]:
    """The agent's runtime identity (Microsoft Learn, Manage hosted agents: instance_identity.principal_id). An agent
    identity uses one ID as both its object and its client ID."""
    principal = (agent.get("instance_identity") or {}).get("principal_id")
    return [principal.lower()] if principal else []


def deploy(name: str, mode: str, code: bytes, toolbox_url: str) -> None:
    t, sha = token(), hashlib.sha256(code).hexdigest()
    with tempfile.TemporaryDirectory() as tmp:
        zip_path, meta_path = pathlib.Path(tmp, f"{name}.zip"), pathlib.Path(tmp, "metadata.json")
        zip_path.write_bytes(code)
        meta_path.write_text(json.dumps(definition(name, mode, toolbox_url)))
        exists = curl("-H", f"Authorization: Bearer {t}", f"{PROJECT}/agents/{name}?{API}")[0] == 200
        url = f"{PROJECT}/agents/{name}?{API}" if exists else f"{PROJECT}/agents?{API}"
        headers = ["-H", f"Authorization: Bearer {t}", "-H", "Accept: application/json", "-H", f"x-ms-code-zip-sha256: {sha}"]
        if not exists:
            headers += ["-H", f"x-ms-agent-name: {name}"]
        status, body = curl("-X", "POST", url, *headers, "-F", f"metadata=@{meta_path};type=application/json", "-F", f"code=@{zip_path};type=application/zip;filename={name}.zip")
    if status not in (200, 201, 202):
        sys.exit(f"{name}: {'update' if exists else 'create'} refused ({status}): {json.dumps(body)[:800]}")
    version = (body.get("versions", {}).get("latest") or body).get("version")
    print(f"{name}: {'updated' if exists else 'created'}, version {version}, zip {sha[:12]}; waiting until active")
    for _ in range(120):
        status, v = curl("-H", f"Authorization: Bearer {token()}", f"{PROJECT}/agents/{name}/versions/{version}?{API}")
        if v.get("status") == "active":
            print(f"{name}: version {version} active")
            return
        if v.get("status") == "failed":
            sys.exit(f"{name}: version {version} failed: {json.dumps(v.get('error'))[:1500]}")
        time.sleep(10)
    sys.exit(f"{name}: version {version} not active after 20 minutes")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--show", action="store_true")
    p.add_argument("--identities", action="store_true")
    a = p.parse_args()
    if a.identities:
        _required("GBX_V2_PROJECT_ENDPOINT")
        t = token()
        ids: list[str] = []
        for name in AGENTS:
            status, agent = curl("-H", f"Authorization: Bearer {t}", f"{PROJECT}/agents/{name}?{API}")
            ids += [i for i in identity_ids(agent) if i not in ids] if status == 200 else []
        print(",".join(ids))
        return
    if not a.show:
        check_settings()
        code, toolbox_url = package(), ensure_toolbox(token()) if FABRIC_ENABLED else ""
        print(f"{TOOLBOX}: {toolbox_url or 'not created, because GBX_FABRIC_ENABLED=false'}")
        for name, mode in AGENTS.items():
            deploy(name, mode, code, toolbox_url)
    else:
        _required("GBX_V2_PROJECT_ENDPOINT")
    t = token()
    for name in AGENTS:
        show(name, t)


if __name__ == "__main__":
    main()
