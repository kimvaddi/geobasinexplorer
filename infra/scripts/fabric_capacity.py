"""Keeps the Fabric capacity behind the knowledge ontology running (docs/FABRIC_KNOWLEDGE.md, Capacity).

    python3 infra/scripts/fabric_capacity.py                   # the capacity's state and the morning job's last run
    python3 infra/scripts/fabric_capacity.py resume            # resume it if paused, wait until it is active, warm the graph
    python3 infra/scripts/fabric_capacity.py resume --no-warm  # the same without the graph question
    python3 infra/scripts/fabric_capacity.py job               # run the morning job now and report what it did

Fabric content is unavailable while its capacity is paused (Microsoft Learn, Pause and resume your Fabric capacity), and
many organisations pause capacities overnight. The optional morning job in infra/bicep/agents/fabric-resume.bicep resumes
it on a schedule, and anyone working after a pause runs `resume` first. The first graph query after a resume can take
about a minute and the next a few seconds, so `resume` asks the graph one small question before it returns. Settings
come from infra/config/environment.env (GBX_AGENTS_SUBSCRIPTION_ID or GBX_SUBSCRIPTION_ID, GBX_FABRIC_CAPACITY_RESOURCE_GROUP
and GBX_FABRIC_CAPACITY_NAME) or the environment. It needs only Python and an Azure CLI sign-in that can read and resume the capacity, read the Fabric workspace
and run the job.
"""
import argparse, json, os, pathlib, subprocess, sys, time, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
def _settings() -> dict:
    env = dict(os.environ)
    path = ROOT / "infra" / "config" / "environment.env"
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.startswith("#") and key.strip() not in env:
                env[key.strip()] = value.strip().strip('"')
    return env


ENV = _settings()
SUB = ENV.get("GBX_AGENTS_SUBSCRIPTION_ID") or ENV.get("GBX_SUBSCRIPTION_ID", "")
CAPACITY = (f"/subscriptions/{SUB}/resourceGroups/{ENV.get('GBX_FABRIC_CAPACITY_RESOURCE_GROUP', 'rg-geobasin-fabric')}"
            f"/providers/Microsoft.Fabric/capacities/{ENV.get('GBX_FABRIC_CAPACITY_NAME', '')}")
JOB = f"/subscriptions/{SUB}/resourceGroups/rg-geobasin-v2-ai/providers/Microsoft.Logic/workflows/logic-gbx2-fabric-resume"
TRIGGER = "Every_morning"
ARM, FABRIC = "https://management.azure.com", "https://api.fabric.microsoft.com"
CAPACITY_API, LOGIC_API = "api-version=2023-11-01", "api-version=2016-06-01"
CONFIG = ROOT / "ingestion-framework" / "config" / "geobasin.json"
WARM_QUERY = "MATCH (b:Basin) RETURN count(b) AS basins"

_tokens: dict[str, tuple[str, float]] = {}
def token(resource: str) -> str:
    if resource not in _tokens or _tokens[resource][1] < time.time() + 300:
        r = json.loads(subprocess.check_output(["az", "account", "get-access-token", "--resource", resource, "-o", "json"]))
        _tokens[resource] = (r["accessToken"], time.time() + 40 * 60)
    return _tokens[resource][0]

def call(method: str, url: str, body=None, resource: str = ARM, timeout: int = 120):
    """Returns (status, lower-cased headers, parsed JSON or None); never raises for an HTTP status."""
    h = {"Authorization": f"Bearer {token(resource)}", "Accept": "application/json"}
    data = json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None)
    if body is not None: h["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=h), timeout=timeout) as r:
            status, rh, raw = r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        status, rh, raw = e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    try: return status, rh, json.loads(raw) if raw else None
    except ValueError: return status, rh, None

def state() -> str:
    s, _, b = call("GET", f"{ARM}{CAPACITY}?{CAPACITY_API}")
    if s != 200: sys.exit(f"The capacity could not be read ({s}): {b}")
    return b["properties"]["state"]

def resume(timeout: int = 600):
    """Resumes a paused capacity, waits through a pause or resume in progress, and returns once it is active."""
    began, asked = time.time(), False
    while time.time() - began < timeout:
        st = state()
        if st == "Active":
            took = f" after {time.time() - began:.0f} s" if asked else ""
            print(f"capacity Active{took}")
            return
        if st in ("Paused", "Suspended") and not asked:
            s, _, b = call("POST", f"{ARM}{CAPACITY}/resume?{CAPACITY_API}")
            if s not in (200, 202): sys.exit(f"The resume was refused ({s}): {b}")
            print(f"capacity {st}; resume accepted")
            asked = True
        else:
            print(f"capacity {st}; waiting")
        time.sleep(5)
    sys.exit(f"The capacity didn't become Active within {timeout} s")

def operation(headers: dict):
    """Follows a Fabric long-running operation through /v1/operations, as the ingestion framework does."""
    op = headers.get("x-ms-operation-id")
    for _ in range(150) if op else ():
        time.sleep(2)
        s, _, b = call("GET", f"{FABRIC}/v1/operations/{op}", resource=FABRIC)
        st = (b or {}).get("status", "").lower()
        if st == "succeeded":
            s, _, b = call("GET", f"{FABRIC}/v1/operations/{op}/result", resource=FABRIC)
            return s, b
        if st in ("failed", "cancelled", "canceled"): return s, b
    return 202, None

def warm(attempts: int = 8):
    """Asks the knowledge graph one small question, so that the first real question after a resume isn't slow."""
    cfg = json.loads(CONFIG.read_text())
    ws, name = cfg["workspace_id"], cfg["graph_model_name"]
    s, _, b = call("GET", f"{FABRIC}/v1/workspaces/{ws}/graphModels", resource=FABRIC)
    if s != 200: sys.exit(f"The workspace's graph models could not be listed ({s}): {b}")
    graph = next((g for g in b.get("value", []) if g.get("displayName") == name), None)
    if graph is None: sys.exit(f"There is no graph model named {name} in workspace {ws}")
    url = f"{FABRIC}/v1/workspaces/{ws}/graphModels/{graph['id']}/executeQuery?beta=true"
    began = time.time()
    for _ in range(attempts):
        s, h, b = call("POST", url, {"query": WARM_QUERY}, resource=FABRIC, timeout=300)
        if s == 202: s, b = operation(h)
        code = b.get("status", {}).get("code") if isinstance(b, dict) else None
        if s == 200 and code in ("00000", "00001"):
            print(f"graph {name} answered in {time.time() - began:.0f} s: {b.get('result', {}).get('data')}")
            return
        reason = f"GQL status {code}" if code else (b.get("errorCode") if isinstance(b, dict) else None)
        print(f"graph {name} not ready ({s}, {reason}); retrying in 20 s")
        time.sleep(20)
    sys.exit(f"The graph {name} didn't answer")

def job(timeout: int = 1200) -> int:
    """Runs the morning job now, waits for the run to finish and lists what each step did."""
    since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 60))
    s, _, b = call("POST", f"{ARM}{JOB}/triggers/{TRIGGER}/run?{LOGIC_API}")
    if s not in (200, 202): sys.exit(f"The job couldn't be started ({s}): {b}")
    began, run = time.time(), None
    while time.time() - began < timeout:
        time.sleep(10)
        s, _, b = call("GET", f"{ARM}{JOB}/runs?{LOGIC_API}&$top=1")
        latest = ((b or {}).get("value") or [None])[0]
        if latest and latest["properties"]["startTime"] >= since and latest["properties"]["status"] not in ("Running", "Waiting"):
            run = latest
            break
    if run is None: sys.exit(f"The job's run didn't finish within {timeout} s")
    p = run["properties"]
    error = f": {p['error']}" if p.get("error") else ""
    print(f"run {run['name']} {p['status']} in {time.time() - began:.0f} s{error}")
    s, _, b = call("GET", f"{ARM}{JOB}/runs/{run['name']}/actions?{LOGIC_API}")
    for a in sorted((b or {}).get("value", []), key=lambda a: a["properties"].get("startTime") or "9"):
        print(f"   {a['name']}: {a['properties']['status']}")
    print(f"capacity {state()}")
    return 0 if p["status"] == "Succeeded" else 1

def status():
    print(f"capacity {state()}")
    s, _, b = call("GET", f"{ARM}{JOB}?{LOGIC_API}")
    if s != 200:
        print("the morning job isn't deployed (infra/bicep/agents/fabric-resume.bicep)")
        return
    rec = b["properties"]["definition"]["triggers"][TRIGGER]["recurrence"]
    hour, minute = int(rec["schedule"]["hours"][0]), int(rec["schedule"]["minutes"][0])
    print(f"morning job {b['properties']['state']}, daily at {hour:02d}:{minute:02d} {rec['timeZone']}")
    s, _, r = call("GET", f"{ARM}{JOB}/runs?{LOGIC_API}&$top=1")
    last = (r or {}).get("value") or []
    print(f"last run {last[0]['properties']['startTime']} {last[0]['properties']['status']}" if last else "no runs yet")

def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="command")
    sub.add_parser("status", help="the capacity's state and the morning job's last run (the default)")
    r = sub.add_parser("resume", help="resume the capacity if it is paused, wait until it is active and warm the graph")
    r.add_argument("--no-warm", action="store_true", help="skip the graph question")
    sub.add_parser("job", help="run the morning job now and report what it did")
    a = p.parse_args()
    if a.command == "resume":
        resume()
        if not a.no_warm: warm()
    elif a.command == "job":
        sys.exit(job())
    else:
        status()

if __name__ == "__main__":
    main()
