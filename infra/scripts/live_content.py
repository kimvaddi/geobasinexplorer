"""The live library's content steps, run without opening the platform's private storage to the operator's machine.

    python3 infra/scripts/live_content.py plan                 which sources the in-network job fetches, which need a hand upload
    python3 infra/scripts/live_content.py run                  seeds the source registry, then lands every fetchable source
    python3 infra/scripts/live_content.py land <id> <file>     lands one source by hand through the site's owner upload route
    python3 infra/scripts/live_content.py manifest <file>      saves the published library manifest, for the knowledge build

The storage account accepts traffic only through its private endpoints, so `run` does the storage work inside the
platform's virtual network: it starts executions of the existing gbx-connect job (infra/bicep/live.bicep), which runs in
the Container Apps environment with the pipeline's own identity. Each execution overrides only the job's command and
arguments, through an execution template made from the job's own template (Microsoft Learn: Jobs in Azure Container Apps,
Start a job execution on demand), so it keeps the job's image, identity and settings.

A few sources can't be fetched by a program: two PEPS SA well packages are registered as "bundle-copy", because PEPS SA
serves them only through its website, and the GDA2020 Technical Manual's publisher refuses programmatic clients
(services/api/src/live/pipeline-registry.ts). `run` lists them, and `land` uploads each one through the app's owner route
(PUT /api/admin/sources/<id>/content), which checks the pinned SHA-256 and sends the file through the same scan and
processing. `land` and `manifest` call the public site with the operator's Azure CLI token for the site's own API, which
site-signin.sh pre-authorizes; the operator holds the GeoBasin owner role. Tokens are kept in memory and sent only in
request headers, never on a command line.

Settings come from the environment that infra/scripts/deploy.sh exports: GBX_SUBSCRIPTION_ID, GBX_LIVE_SOURCES and, for
land and manifest, GBX_SITE_URL and GBX_SITE_APP_ID. GBX_CONTENT_PARALLEL sets how many sources land at once (default 4).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "services" / "api" / "src" / "live" / "pipeline-registry.ts"
APP_RG = "rg-geobasin-app"
JOB = "gbx-connect"
DONE = {"Succeeded", "Failed", "Stopped", "Degraded"}
ENTRY = re.compile(r'^\s*"(?P<id>[a-z0-9-]+)":\s*\{\s*name:\s*"(?P<name>[^"]+)",\s*sha256:\s*"(?P<sha>[0-9a-f]{64})",\s*url:\s*"(?P<url>[^"]+)"(?P<rest>[^}]*)\}', re.M)

# Where each hand-landed source comes from. The bytes must match the registry's pinned SHA-256 exactly.
MANUAL_HELP = {
    "peps-sa-marabooka-1": "Download Marabooka1_report.pdf (Marabooka 1 well completion report, envelope 4324) from PEPS SA, https://peps.sa.gov.au/.",
    "peps-sa-habanero-1": "Download Habanero_001_DownholeDiagram.zip, habanero_1_multi_finger_cali_report.pdf and "
                          "habanero_1_pts_23sept2005_presstemp.pdf from PEPS SA, https://peps.sa.gov.au/, into one folder, then build the "
                          "archive: python3 pipeline/bundle_habanero.py <folder> build/habanero-1-pdfs.zip",
    "icsm-gda2020-manual": "Download the GDA2020 Technical Manual, version 1.8, in a browser from the registered address below.",
}


def registry() -> dict[str, dict[str, str | bool]]:
    """The source artifacts registered in pipeline-registry.ts, read from the source file itself."""
    text = REGISTRY.read_text(encoding="utf-8")
    block = text.split("export const SOURCE_ARTIFACTS = {", 1)[1].split("} as const;", 1)[0]
    found = {m["id"]: {"name": m["name"], "sha256": m["sha"], "url": m["url"], "ownerUpload": "ownerUpload: true" in m["rest"]}
             for m in ENTRY.finditer(block)}
    if not found:
        sys.exit(f"No source artifacts could be read from {REGISTRY}")
    return found


def requested() -> list[str]:
    ids = [i.strip() for i in os.environ.get("GBX_LIVE_SOURCES", "").split(",") if i.strip()]
    if not ids:
        sys.exit("GBX_LIVE_SOURCES is empty; list the sources to land in infra/config/environment.env.")
    known = registry()
    unknown = [i for i in ids if i not in known]
    if unknown:
        sys.exit(f"GBX_LIVE_SOURCES names sources the registry doesn't have: {', '.join(unknown)}")
    return list(dict.fromkeys(ids))


def manual(source: dict) -> bool:
    return bool(source["ownerUpload"]) or not str(source["url"]).startswith("https://")


def az(*args: str) -> str:
    sub = os.environ.get("GBX_SUBSCRIPTION_ID", "")
    return subprocess.run(["az", *args, *(["--subscription", sub] if sub else []), "-o", "json"],
                          check=True, capture_output=True, text=True).stdout


def plan() -> tuple[list[str], list[str]]:
    known, ids = registry(), requested()
    fetched = [i for i in ids if not manual(known[i])]
    by_hand = [i for i in ids if manual(known[i])]
    return fetched, by_hand


def print_manual(ids: list[str]) -> None:
    if not ids:
        return
    known = registry()
    print(f"\n{len(ids)} source(s) need a hand upload, because their publishers serve them only to a browser:")
    for i in ids:
        s = known[i]
        print(f"\n  {i}  ({s['name']}, SHA-256 {s['sha256']})")
        print(f"    {MANUAL_HELP.get(i, 'Download the registered file in a browser.')}")
        if str(s["url"]).startswith("https://"):
            print(f"    Registered address: {s['url']}")
        print(f"    Then: python3 infra/scripts/live_content.py land {i} <downloaded file>")


class Job:
    """Executions of gbx-connect with their own command and arguments."""

    def __init__(self) -> None:
        self.template = json.loads(az("containerapp", "job", "show", "-n", JOB, "-g", APP_RG, "--query", "properties.template"))
        if not self.template or not self.template.get("containers"):
            sys.exit(f"The {JOB} job has no template; run infra/scripts/deploy.sh platform first.")

    def start(self, command: list[str], args: list[str]) -> str:
        template = json.loads(json.dumps(self.template))
        template["containers"][0]["command"] = command
        template["containers"][0]["args"] = args
        # JSON is YAML, so the CLI reads the execution template as it is.
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            json.dump(template, f)
        try:
            out = json.loads(az("containerapp", "job", "start", "-n", JOB, "-g", APP_RG, "--yaml", f.name))
        finally:
            os.unlink(f.name)
        return out.get("name") or out["id"].rsplit("/", 1)[-1]

    def status(self, execution: str) -> str:
        # A just-started execution can be invisible for a few seconds, and bursts of calls are throttled, so a failed
        # read means "not finished yet"; the caller's time limit still ends an execution that never reports.
        try:
            return json.loads(az("containerapp", "job", "execution", "show", "-n", JOB, "-g", APP_RG,
                                 "--job-execution-name", execution, "--query", "properties.status"))
        except subprocess.CalledProcessError:
            return "Unknown"

    def wait(self, execution: str, limit_s: int = 900) -> str:
        start = time.time()
        while time.time() - start < limit_s:
            state = self.status(execution)
            if state in DONE:
                return state
            time.sleep(10)
        return "TimedOut"


def run() -> int:
    fetched, by_hand = plan()
    job = Job()
    print("Seeding the source registry inside the virtual network...")
    seed = job.wait(job.start(["node", "dist/scripts/live-bootstrap.mjs"], ["--seed-registry"]))
    if seed != "Succeeded":
        sys.exit(f"Seeding the registry ended {seed}. See the {JOB} job's execution history and logs (ContainerAppConsoleLogs_CL).")
    parallel = max(1, int(os.environ.get("GBX_CONTENT_PARALLEL", "4")))
    print(f"Landing {len(fetched)} source(s) from their publishers, {parallel} at a time...")
    pending, running, results = list(fetched), {}, {}
    while pending or running:
        while pending and len(running) < parallel:
            sid = pending.pop(0)
            running[sid] = (job.start(["node", "dist/scripts/live-connect.mjs"], [sid]), time.time())
        time.sleep(10)
        for sid, (execution, started) in list(running.items()):
            state = job.status(execution)
            if state not in DONE and time.time() - started < 900:
                continue
            results[sid] = state if state in DONE else "TimedOut"
            del running[sid]
            print(f"  {sid}: {results[sid]} ({execution})")
    failed = sorted(s for s, state in results.items() if state != "Succeeded")
    print(f"\n{len(results) - len(failed)} of {len(results)} fetched source(s) landed.")
    if failed:
        print(f"Not landed: {', '.join(failed)}. Each execution's log is in ContainerAppConsoleLogs_CL; rerun to retry, because a"
              " source that already landed is checked again rather than landed twice.")
    print_manual(by_hand)
    return 1 if failed else 0


def site() -> tuple[str, str]:
    url, app = os.environ.get("GBX_SITE_URL", "").rstrip("/"), os.environ.get("GBX_SITE_APP_ID", "")
    if not url or not app:
        sys.exit("Set GBX_SITE_URL, and run infra/scripts/deploy.sh signin site edge first, so the site can be reached.")
    token = subprocess.run(["az", "account", "get-access-token", "--scope", f"api://{app}/.default", "--query", "accessToken", "-o", "tsv"],
                           check=True, capture_output=True, text=True).stdout.strip()
    return url, token


def land(source_id: str, file: pathlib.Path) -> int:
    known = registry()
    if source_id not in known:
        sys.exit(f"{source_id} isn't in the source registry.")
    data = file.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != known[source_id]["sha256"]:
        sys.exit(f"{file} has SHA-256 {digest}, but {source_id} is pinned to {known[source_id]['sha256']}. Download the registered file again.")
    url, token = site()
    request = urllib.request.Request(f"{url}/api/admin/sources/{source_id}/content", data=data, method="PUT",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            print(f"{source_id}: HTTP {response.status} {response.read().decode('utf-8', 'replace')[:400]}")
            return 0
    except urllib.error.HTTPError as error:
        print(f"{source_id}: HTTP {error.code} {error.read().decode('utf-8', 'replace')[:400]}", file=sys.stderr)
        return 1


def manifest(out: pathlib.Path) -> int:
    url, token = site()
    request = urllib.request.Request(f"{url}/api/live/manifest", headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        body = json.load(response)
    if not body.get("enabled"):
        print(f"The site has no published library yet ({body.get('reason', 'nothing published')}); nothing saved.", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8")
    print(f"Saved manifest version {body['manifestVersion']} with {len(body['sources'])} sources to {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("plan")
    sub.add_parser("run")
    one = sub.add_parser("land")
    one.add_argument("source_id")
    one.add_argument("file", type=pathlib.Path)
    saved = sub.add_parser("manifest")
    saved.add_argument("file", type=pathlib.Path)
    args = ap.parse_args()
    if args.command == "plan":
        fetched, by_hand = plan()
        print(f"{len(fetched)} source(s) land through the {JOB} job inside the virtual network.")
        print_manual(by_hand)
        return 0
    if args.command == "run":
        return run()
    if args.command == "land":
        return land(args.source_id, args.file)
    return manifest(args.file)


if __name__ == "__main__":
    raise SystemExit(main())
