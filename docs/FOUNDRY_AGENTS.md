# Scientist agents

GeoBasin Explorer AI answers questions and tests hypotheses with a team of specialist AI scientists. They form one Microsoft Agent Framework workflow, written in Python in [services/scientists](../services/scientists). Microsoft Foundry hosts the workflow as two agents:

| Agent | Purpose |
|---|---|
| `gbx-copilot` | Answers the copilot's questions. |
| `gbx-coscientist` | Tests a user's hypothesis. |

This guide covers the Foundry setup, the scientists, the workflow, the tools, identity, data storage, the model router and deployment.

## Foundry setup

The agents run in a dedicated Microsoft Foundry account, created by [infra/bicep/agents/foundry.bicep](../infra/bicep/agents/foundry.bicep) or [infra/terraform/agents.tf](../infra/terraform/agents.tf). It is adapted from Microsoft's official standard agent setup sample.

- **Your data stays yours.** Foundry Agent Service keeps threads, conversation history, messages and agent definitions in your own Cosmos DB, files in your own Storage account, and vector stores in your own Azure AI Search service.
- **No keys.** Local authentication is disabled on every resource, and every caller uses Microsoft Entra ID.
- **Network perimeter.** The agents' Cosmos DB and Storage accept traffic only through a network security perimeter that admits managed identities from the same subscription.
- **Flexible placement.** The account can live in the platform's subscription or in a second subscription that has Data Zone quota for its models.

| Deployment | Purpose |
|---|---|
| `gbx2-router` | Foundry model router. Serves every scientist except the validator. |
| `gbx2-validator` | Fixed deployment from a different model family. Checks every statement. |
| `gbx2-embed` | Embeddings. |

One project, `geobasin-v2`, holds the hosted agents, the `gbx-knowledge` toolbox with the Fabric IQ tool, and the connections to the agent data stores.

## The scientists

| Agent | Question it answers | Tools | Model |
|---|---|---|---|
| Lead | Which specialists does this need? Once they report, what is the answer or the tally? | None | `gbx2-router` |
| Literature | What do the published reports and well files say? | Search over live and packaged evidence; reopen a cited page | `gbx2-router` |
| Stratigraphy | Which units, plays and formations are involved, and how do they relate? | The ontology through Fabric IQ as the user; typed knowledge tools over the graph | `gbx2-router` |
| Spatial | Where are things, how far apart, and which plays are analogs? | GDAL/PROJ spatial service; analog ranking | `gbx2-router` |
| Rock | What do the core photos and figures show? | Core images and figures linked to units, plays and wells | `gbx2-router` |
| Stress | What is the stress regime? | World Stress Map records for each basin | `gbx2-router` |
| Critic | What evidence contradicts the draft, and what is missing? Can block. | The same read-only tools | `gbx2-router` |
| Validator | Is every statement supported by the evidence it cites? | The evidence the specialists returned | `gbx2-validator` |

The router's model set excludes the validator's model family. The validator never checks text written by its own kind of model.

## The workflow

Agent Framework offers sequential, concurrent, handoff, group chat and Magentic orchestrations. GeoBasin uses a custom workflow graph of executors and edges instead, because the order of steps is fixed and the validator must be a step that no orchestrator can skip.

1. **Plan.** The lead reads the question or statement and picks the specialists it needs. Specialists that were not picked stand down without calling a model.
2. **Gather.** The chosen specialists run at the same time, each with only its own tools. Every finding carries the identifiers of the passages and rows it rests on.
3. **Draft.** A fan-in edge gathers the findings. The lead writes the draft answer or, for the Co-Scientist, the tally of evidence for, against and missing.
4. **Challenge.** The critic reviews the numbered statements and names each problem. A conditional edge can send the draft back to the lead once for a rebuttal.
5. **Remove.** Statements the critic still disputes are removed, with the reason, and listed as removed. The rest of the answer continues. Only an objection to the whole draft, or one that leaves no fact standing, ends the run without an answer, and the dissent is shown.
6. **Validate.** The validator checks every remaining statement against the evidence actually returned.

| Outcome | Result |
|---|---|
| The validation check fails | "Validation incomplete" (an unchecked answer is never shown) |
| The evidence cannot answer the question | "Not found" |
| Every chosen specialist failed | "Validation incomplete" (nothing was searched) |

For the Co-Scientist, the run ends with the findings, the critic's report and the tally. The user records the verdict in the app: accept, reject or needs more data, with a one-line reason. No agent approves anything.

## Tools

The scientists never call Azure AI Search, Storage or Fabric directly. Their tools live on one read-only MCP tool server inside the API, at `/api/mcp`, enabled with `GBX_TOOL_SERVER=on` ([tool-server.ts](../services/api/src/v2/tool-server.ts)).

Why the tools live in the API:

- the storage account stays closed, because the API is already inside its network;
- allowlists, limits, license filters and access filters stay in one place.

The server is small and strict. Each request carries one JSON-RPC message and receives one JSON reply, with no sessions, streams or batches. It refuses browsers and any caller whose identity is not in `GBX_TOOL_CALLERS`.

| Tool group | What it does |
|---|---|
| Passage tools | Search live and packaged evidence and reopen a cited page |
| Depth conversion | Converts depths below the kelly bushing to depths below sea level |
| Typed knowledge tools: `knowledge_basin`, `knowledge_unit`, `knowledge_well`, `knowledge_play` ([knowledge.ts](../services/api/src/v2/knowledge.ts)) | Read the Fabric graph with the app's own Fabric identity |

The knowledge tools never accept free-form graph queries from a model. Each one fills a fixed, parameterized query with a cleaned name, within the API's own limits, which are well inside the graph query API's limits. Every piece of evidence has a stable identifier derived from its source, its dataset and its license, so a well's total depth can be cited as precisely as a report page.

The workflow connects to the tool server with Agent Framework's MCP tool, which can attach headers to each call. The Fabric IQ tool lives in a Foundry toolbox, `gbx-knowledge`, because a toolbox can pass each user's own Entra token to Fabric.

## Identity and the run ticket

Three identities take part in every run. None of them uses a key.

| Identity | Used for | Access |
|---|---|---|
| `id-gbx-site-agents` (the app's managed identity) | Calling the hosted agents | Foundry Agent Consumer (the least-privileged built-in role for calling an agent endpoint) on each agent it calls, and nothing else |
| Each hosted agent's Entra agent identity | Calling the models and the tool server | Granted per agent |
| `id-gbx-site-fabric` (the tool server's identity) | Reading the Fabric knowledge graph | Viewer on the knowledge workspace and a OneLake security role over the graph's source tables ([grant-fabric-reader.sh](../infra/scripts/grant-fabric-reader.sh)) |

**The run ticket** carries the user's context:

- The API issues it when it books a question's limits. It is signed with HMAC-SHA256 under a key only the API holds, and lives at most 15 minutes.
- It names the run, the user, their place limits and the live sources the question needs.
- The app sends it to the hosted agent in the request metadata, split across four keys because each metadata value holds at most 512 characters.
- The hosting code attaches it only as the `x-gbx-run-ticket` header on that run's own MCP connection. The model never sees it.
- The tool server accepts a call only with both the hosted agent's Entra token and a valid ticket. It then applies the user's limits and access filters and records the call in the run's register.

**Per-user sessions.** Foundry keeps each caller's sessions private. Because the app calls on everyone's behalf, it tells Foundry whom each run is for: it sends the signed-in user's Entra object ID, taken from the sign-in layer and never from the browser, in the `x-ms-user-identity` header. That header needs a data action that no built-in role includes. [grant-agent-caller.sh](../infra/scripts/grant-agent-caller.sh) creates a custom role, GeoBasin Agent User Delegation, named after the deployment's Foundry account because custom role names are unique across a directory. The role holds only that action, and the script assigns it with Foundry Agent Consumer, scoped to the two agents.

## How the app calls the agents

With `GBX_V2_SCIENTISTS=on` and `GBX_V2_COPILOT=on`, the Co-Scientist and the copilot call the hosted agents instead of the rule-based fallbacks. The API:

1. starts a background response on the agent's endpoint;
2. polls it;
3. maps the output (answer or tally, citations, removed statements and who removed them, and the trace of specialists and models) onto the same answer contract as the rest of the app.

A throttled or failed run returns a clear message, never a partial answer.

## Fabric IQ as the user

The ontology's MCP endpoint answers only a user or an OAuth session, never a service principal. So the stratigraphy specialist queries it as the signed-in user:

1. The sign-in layer keeps each user's tokens in a token store: a private blob container that the app's agents identity can write.
2. The API exchanges the user's token on their behalf. The sign-in registration trusts the agents identity through a federated identity credential, so there is no client secret.
3. The API starts the run with the user's own Foundry token.
4. The hosted agents reach Fabric IQ through the `gbx-knowledge` toolbox with the user's permissions, so Fabric applies the user's own access to the ontology and its data.

[grant-fabric-iq.sh](../infra/scripts/grant-fabric-iq.sh) declares the delegated permissions, grants tenant-wide consent, adds the federated credential, and gives the agents' identities Foundry User on the project, which Fabric IQ through a toolbox requires.

Each user also needs access to the agents and read access to the ontology in Fabric. Without them, the run starts as the app, and the specialist falls back to the typed knowledge tools.

## Where conversations and agent data live

- **Standard setup.** Agent Service keeps threads, conversation history, messages and agent definitions in your Cosmos DB, files in your Storage account and vector stores in your AI Search service.
- **Responses protocol.** The hosted agents use it, so their conversations are the platform-managed kind that the standard setup stores.
- **No unneeded history.** Calls that need no history, such as the validator's checks, set `store` to false, so no response is kept.
- **Data Zone Standard.** Model deployments keep processing within the data zone of the account's region.

## Model router

The router follows Microsoft's guidance:

- **Approved models only.** The router's model set is the compliance gate. A new model appears only after an explicit change to `routerModels` in the template.
- **At least two models.** A single-model set loses routing and automatic failover.
- **Context fits.** The smallest context window in the set must fit the largest prompt: the lead's synthesis with every finding.
- **Observable.** Every response names the model that served it. The workflow logs it for each step, and Azure Monitor shows how traffic is split.
- **One rate limit.** The tokens-per-minute limit is set once on the router deployment and covers all routed traffic. Throttling appears as HTTP 429 responses, which the workflow retries with backoff.
- **Careful tuning.** Start in balanced mode and change one setting at a time. Rerun the evaluation after each change, so differences in quality, cost and time can be attributed.

## Deploy and update the agents

[deploy_hosted.py](../services/scientists/deploy_hosted.py) deploys both agents from source, following Microsoft Learn's REST path for deploying a hosted agent from source code. It:

1. packages `main.py`, `requirements.txt` and the `gbx_scientists` package into a flat zip with fixed timestamps, so unchanged code produces the same digest and Foundry creates no new version;
2. makes sure the `gbx-knowledge` toolbox holds the Fabric IQ tool;
3. creates or updates each agent and waits until it is active.

It reads its settings from the environment: `GBX_V2_PROJECT_ENDPOINT`, `GBX_SITE_URL`, `GBX_SITE_APP_ID`, `GBX_FABRIC_WORKSPACE_ID` and `GBX_FABRIC_ONTOLOGY_ID`. `infra/scripts/deploy.sh hosted` exports all of them for you. Use `--show` to print each agent's version and identity, and `--identities` to print the agents' identity object IDs, which the site needs for its tool-server allowlist and grants.

```bash
infra/scripts/deploy.sh hosted              # deploy or update both agents, then redeploy the site with their identities
python3 services/scientists/deploy_hosted.py --show
python3 infra/scripts/foundry_smoke.py      # checks the Foundry setup: router models, deployments, agent data
```

## References

- [Standard agent setup](https://learn.microsoft.com/azure/foundry/agents/concepts/standard-agent-setup)
- [Hosted agents with Agent Framework](https://learn.microsoft.com/agent-framework/hosting/foundry-hosted-agent) and [managing hosted agents](https://learn.microsoft.com/azure/foundry/agents/how-to/manage-hosted-agent)
- [Agent Framework orchestrations](https://learn.microsoft.com/agent-framework/workflows/orchestrations/) and [workflow edges](https://learn.microsoft.com/agent-framework/concepts/workflows/edges)
- [MCP tools in Agent Framework](https://learn.microsoft.com/agent-framework/agents/tools/local-mcp-tools) and [tool authentication](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/tool-authentication)
- [Fabric IQ](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/fabric-iq)
- [Agent-scope role assignments](https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry#agent-scope-role-assignments), [delegating the end user's identity](https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agent-permissions#delegate-the-end-user-identity) and [isolating sessions per user](https://learn.microsoft.com/azure/foundry/agents/how-to/isolate-sessions-per-user)
- [How model router works](https://learn.microsoft.com/azure/foundry/openai/concepts/model-router-how-it-works#best-practices) and [model router with agents](https://learn.microsoft.com/azure/foundry/openai/how-to/model-router-agents)
- [Quota and rate limits](https://learn.microsoft.com/azure/foundry/openai/how-to/quota#understanding-rate-limits)
