"""Proves the version 2 Foundry foundation works (infra/bicep/agents/foundry.bicep; docs/FOUNDRY_AGENTS.md).

    python3 infra/scripts/foundry_smoke.py                  # every check, then delete what the checks created
    python3 infra/scripts/foundry_smoke.py --keep           # leave the smoke agent and its conversation in place
    python3 infra/scripts/foundry_smoke.py --out run.json   # also write the evidence as JSON

What it checks, signed in as the operator through the Azure CLI, with nothing else installed:
  1. The project's capability host has provisioned, so Agent Service uses GeoBasin's own Cosmos DB, Storage and Search.
  2. The model router's routing subset holds at least two models and no xAI model (docs/FOUNDRY_AGENTS.md, Model router).
  3. The model router answers on the project's OpenAI-compatible v1 endpoint, the route the agents use, and names the
     model it chose.
  4. Grok 4.1 Fast, the validator, answers on the same endpoint.
  5. A throwaway prompt agent on the router holds a two-turn conversation, and its second answer depends on the first,
     so the conversation history is kept.
  6. That conversation lands in GeoBasin's own Cosmos DB, in the database enterprise_memory that the standard setup
     creates (Microsoft Learn, Set up standard agent resources).
  7. Unless --keep is given, it deletes the conversation's items, the responses, the conversation and the agent, then
     reports any of the conversation's documents that Cosmos DB still holds a minute later.
The project and v1 data-plane routes follow docs/FOUNDRY_AGENTS.md: agent management takes ?api-version=v1, the
/openai/v1 routes take no api-version, and a response names its agent with agent_reference. The operator needs Foundry
User on the account and Cosmos DB Built-in Data Reader on the Cosmos DB account, which infra/bicep/agents/foundry.bicep grants;
new role assignments can take a few minutes to apply, so the first calls retry.
"""
import argparse, collections, email.utils, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

SUB = os.environ.get("GBX_AGENTS_SUBSCRIPTION_ID") or os.environ["GBX_SUBSCRIPTION_ID"]  # exported by infra/scripts/lib.sh
DEPLOYMENT = "gbx2-foundry"
ARM_API = "2025-10-01-preview"
AI = "https://ai.azure.com/.default"
AGENT = "gbx2-smoke"
DATABASE = "enterprise_memory"

_tokens: dict[str, tuple[str, float]] = {}
def token(scope: str) -> str:
    if scope not in _tokens or _tokens[scope][1] < time.time() + 300:
        r = json.loads(subprocess.check_output(["az", "account", "get-access-token", "--scope", scope, "-o", "json"]))
        _tokens[scope] = (r["accessToken"], time.time() + 40 * 60)
    return _tokens[scope][0]

def az(*args: str):
    return json.loads(subprocess.check_output(["az", *args, "--subscription", SUB, "-o", "json"]))

def call(method: str, url: str, body=None, headers=None, timeout=180):
    """Returns (status, headers, parsed JSON or raw bytes); never raises for an HTTP status."""
    h = {"Accept": "application/json", **({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})}
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, rh, raw = r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        status, rh, raw = e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    try: return status, rh, json.loads(raw) if raw else None
    except ValueError: return status, rh, raw

def foundry(method: str, url: str, body=None, wait_for_access=False):
    """A Foundry call with the operator's Entra token, retrying throttling and, at first, role propagation."""
    for attempt in range(12):
        s, h, b = call(method, url, body, {"Authorization": f"Bearer {token(AI)}"})
        if s in (401, 403) and wait_for_access and attempt < 11:
            print(f"   access not yet in effect ({s}); waiting 30 s"); time.sleep(30); continue
        if s == 429 or s >= 500:
            time.sleep(min(int(h.get("retry-after", "10") or 10), 60)); continue
        return s, b
    return s, b

def need(ok: bool, what: str, detail=None):
    if not ok: sys.exit(f"FAILED: {what}{f': {detail}' if detail is not None else ''}")

def cosmos(account: str, method: str, path: str, body=None, extra=None):
    """A Cosmos DB data-plane call with the operator's Entra token, retrying the brief 403s seen while the perimeter's
    rules settle, throttling and server errors."""
    for attempt in range(10):
        sig = urllib.parse.quote(f"type=aad&ver=1.0&sig={token(f'https://{account}.documents.azure.com/.default')}", safe="")
        h = {"Authorization": sig, "x-ms-date": email.utils.formatdate(usegmt=True), "x-ms-version": "2018-12-31", **(extra or {})}
        s, rh, b = call(method, f"https://{account}.documents.azure.com/{path}", body, h)
        if (s == 403 or s == 429 or s >= 500) and attempt < 9:
            print(f"   Cosmos DB answered {s} for {path}; retrying in 30 s"); time.sleep(30); continue
        return s, rh, b

def containers(account: str) -> list[str]:
    s, _, b = cosmos(account, "GET", "dbs")
    need(s == 200, "Cosmos DB lists its databases", s)
    need(any(d["id"] == DATABASE for d in b["Databases"]), f"database {DATABASE} exists", [d["id"] for d in b["Databases"]])
    s, _, b = cosmos(account, "GET", f"dbs/{DATABASE}/colls")
    need(s == 200, "Cosmos DB lists its containers", s)
    return sorted(c["id"] for c in b["DocumentCollections"])

def documents(account: str, container: str) -> list[dict]:
    docs, cont = [], None
    while True:
        extra = {"Content-Type": "application/query+json", "x-ms-documentdb-isquery": "True",
                 "x-ms-documentdb-query-enablecrosspartition": "True", "x-ms-max-item-count": "1000", **({"x-ms-continuation": cont} if cont else {})}
        s, h, b = cosmos(account, "POST", f"dbs/{DATABASE}/colls/{container}/docs", {"query": "SELECT * FROM c", "parameters": []}, extra)
        need(s == 200, f"Cosmos DB returns the documents of {container}", s)
        docs += b["Documents"]
        cont = h.get("x-ms-continuation")
        if not cont: return docs

def census(account: str, partition: str | None = None) -> dict:
    """For each container: how many documents it holds and how many belong to the given conversation partition."""
    out = {}
    for c in containers(account):
        docs = documents(account, c)
        mine = [d for d in docs if partition and str(d.get("partition_id", "")).endswith(f"/{partition}")]
        out[c] = {"documents": len(docs), "inConversation": len(mine), "kinds": dict(collections.Counter(d["id"].split("_")[0] for d in mine))}
    return out

def text(response: dict) -> str:
    return " ".join(c.get("text", "") for item in response.get("output", []) if item.get("type") == "message"
                    for c in item.get("content", []) if c.get("type") in ("output_text", "text")).strip()

def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--keep", action="store_true", help="leave the smoke agent and its conversation in place")
    p.add_argument("--out", help="also write the evidence to this JSON file, whether the checks pass or not")
    a = p.parse_args()
    ev: dict = {}
    try:
        run(a, ev)
    finally:
        if a.out:
            with open(a.out, "w") as f: json.dump(ev, f, indent=2)
    print("PASSED")

def run(a, ev: dict):
    o = {k: v["value"] for k, v in az("deployment", "sub", "show", "-n", DEPLOYMENT, "--query", "properties.outputs").items()}
    rg, account, project, cosmos_account = o["resourceGroup"], o["accountName"], o["projectEndpoint"], o["cosmosName"]
    ev.update({"account": account, "project": project, "cosmosAccount": cosmos_account, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    print("1. Capability host")
    hosts = az("rest", "--method", "get", "--url", f"https://management.azure.com/subscriptions/{SUB}/resourceGroups/{rg}/providers/Microsoft.CognitiveServices/accounts/{account}/projects/{o['projectName']}/capabilityHosts?api-version={ARM_API}")["value"]
    need(len(hosts) == 1 and hosts[0]["properties"].get("provisioningState") == "Succeeded", "the project capability host has provisioned", hosts)
    ev["capabilityHost"] = {k: hosts[0]["properties"].get(k) for k in ("provisioningState", "threadStorageConnections", "storageConnections", "vectorStoreConnections")}
    print(f"   {hosts[0]['name']}: {ev['capabilityHost']}")

    print("2. Routing subset")
    routing = az("cognitiveservices", "account", "deployment", "show", "-g", rg, "-n", account, "--deployment-name", o["routerDeployment"])["properties"].get("routing") or {}
    models = routing.get("models") or []
    need(len(models) >= 2 and all(m.get("format") != "xAI" for m in models), "the router lists at least two models and no xAI model", routing)
    ev["routing"] = {"mode": routing.get("mode"), "models": [f"{m['format']}/{m['name']} {m['version']}" for m in models]}
    print(f"   {ev['routing']}")

    for step, deployment, key in (("3. Model router", o["routerDeployment"], "router"), ("4. Grok validator", o["validatorDeployment"], "validator")):
        print(step)
        s, b = foundry("POST", f"{project}/openai/v1/chat/completions",
                       {"model": deployment, "messages": [{"role": "user", "content": "In one short sentence, which country holds the Cooper Basin?"}]}, wait_for_access=True)
        need(s == 200, f"{deployment} answers", b)
        reply = b["choices"][0]["message"]["content"].strip()
        need("australia" in reply.lower(), f"{deployment} answers correctly", reply)
        ev[key] = {"deployment": deployment, "servedBy": b.get("model"), "reply": reply, "tokens": (b.get("usage") or {}).get("total_tokens")}
        print(f"   served by {b.get('model')}: {reply}")

    print("5. Agent conversation")
    before = census(cosmos_account)
    s, agent = foundry("POST", f"{project}/agents/{AGENT}/versions?api-version=v1", {
        "definition": {"kind": "prompt", "model": o["routerDeployment"], "instructions": "You test GeoBasin version 2's Foundry setup. Answer in one short sentence."},
        "description": "Throwaway agent created and deleted by infra/scripts/foundry_smoke.py", "metadata": {"purpose": "phase-1a-smoke"}}, wait_for_access=True)
    need(s == 200, "the smoke agent version is created", agent)
    ref = {"type": "agent_reference", "name": AGENT, "version": agent["version"]}
    s, conv = foundry("POST", f"{project}/openai/v1/conversations", {})
    need(s == 200, "a conversation is created", conv)
    turns = []
    for question in ("Which country holds the Cooper Basin?", "Which two states does it span?"):
        s, r = foundry("POST", f"{project}/openai/v1/responses", {"conversation": conv["id"], "input": question, "agent_reference": ref})
        need(s == 200 and r.get("status") == "completed", f"the agent answers '{question}'", r)
        turns.append({"question": question, "id": r["id"], "model": r.get("model"), "answer": text(r)})
        print(f"   {question} {text(r)}")
    need("queensland" in turns[1]["answer"].lower() and "south australia" in turns[1]["answer"].lower(),
         "the second answer uses the first turn, so the conversation history is kept", turns[1]["answer"])
    s, items = foundry("GET", f"{project}/openai/v1/conversations/{conv['id']}/items?limit=100")
    need(s == 200, "the conversation's items are listed", items)
    # The conversation's ID and its responses' IDs share the partition key under which Cosmos DB stores its documents.
    partition = conv["id"][5:23]
    need(conv["id"].startswith("conv_") and all(t["id"][5:23] == partition for t in turns), "the responses share the conversation's partition", [conv["id"], *(t["id"] for t in turns)])
    ev["agent"] = {"name": AGENT, "version": agent["version"], "conversation": conv["id"], "partition": partition, "turns": turns, "items": [i["id"] for i in items["data"]]}

    print("6. Cosmos DB")
    for _ in range(12):
        after = census(cosmos_account, partition)
        if any(v["inConversation"] for v in after.values()): break
        time.sleep(10)
    ev["cosmos"] = {"before": before, "after": after}
    for c, v in after.items(): print(f"   {c}: {v['documents']} documents ({v['documents'] - before.get(c, {}).get('documents', 0):+d}), {v['inConversation']} in this conversation {v['kinds'] or ''}")
    need(any(v["inConversation"] for v in after.values()), "the conversation lands in GeoBasin's Cosmos DB", after)

    if not a.keep:
        print("7. Clean-up")
        # The order docs/FOUNDRY_AGENTS.md set for version 1: each item, then the responses, the conversation and the
        # agent. Every delete answers 200, but on 8 November 2026 the item documents and their links to the conversation
        # stayed in Cosmos DB afterwards (docs/FOUNDRY_AGENTS.md), so they are reported here rather than failed on.
        done = {i["id"]: foundry("DELETE", f"{project}/openai/v1/conversations/{conv['id']}/items/{i['id']}")[0] for i in items["data"]}
        done.update({t["id"]: foundry("DELETE", f"{project}/openai/v1/responses/{t['id']}")[0] for t in turns})
        done[conv["id"]] = foundry("DELETE", f"{project}/openai/v1/conversations/{conv['id']}")[0]
        done[AGENT] = foundry("DELETE", f"{project}/agents/{AGENT}?api-version=v1")[0]
        print(f"   delete statuses {done}")
        need(all(s in (200, 204) for s in done.values()), "every delete succeeds", done)
        time.sleep(60)
        left = census(cosmos_account, partition)
        ev["cleanup"] = {"deleted": done, "cosmosAfterDelete": left}
        for c, v in left.items():
            if v["inConversation"]: print(f"   WARNING {c}: {v['inConversation']} documents of the deleted conversation remain {v['kinds']}")
        if not any(v["inConversation"] for v in left.values()): print("   nothing of the conversation remains in Cosmos DB")

if __name__ == "__main__":
    main()
