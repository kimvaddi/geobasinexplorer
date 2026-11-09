# Security and responsible AI

GeoBasin Explorer AI is secure by default and grounded by design. This guide describes:

- the controls the platform applies;
- the decisions each deployment must make;
- the practices that keep AI answers trustworthy.

See also [ARCHITECTURE.md](ARCHITECTURE.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## Summary

| Area | Control |
|---|---|
| Identity | Microsoft Entra ID for every caller. No keys anywhere. One managed identity per workload with least-privilege roles. |
| Network | Front Door with a web application firewall is the only public entry. Private Link to the app. Private endpoints for storage and Key Vault. A network security perimeter for agent data. |
| Data | Encrypted at rest and in transit (TLS 1.2 or later). Agent data stays in your own stores. Data Zone Standard model processing. |
| Malware | Every upload and fetched file is scanned before anything reads it. |
| Agents | Read-only tool server, signed run tickets, per-user limits and access filters. |
| AI answers | Cited evidence, an independent validator, visible removals, "Not found" instead of guessing. |
| People | Experts approve extractions. Only a person records a Co-Scientist verdict. |

## Identity and access

**No keys.** Every caller authenticates with Microsoft Entra ID. Local authentication is disabled on the Foundry accounts, Document Intelligence, Azure AI Search, Cosmos DB, Azure Maps and both storage accounts. The storage accounts refuse shared-key access.

**Least privilege.** Each workload has its own user-assigned managed identity, with only the roles it needs, scoped as narrowly as the service allows:

| Identity | Access |
|---|---|
| Web app | Write to the quarantine container only. Read the approved containers only. |
| Ingestion job | Process its own queue only. |
| Scanner | Read quarantine and the signatures container. |
| Map identity | A custom role with render read only. |
| App's agent caller | Foundry Agent Consumer on its two agents only. |
| Knowledge graph reader | Viewer on one workspace, plus a OneLake security role over exactly the tables the graph reads. |

**Sign-in.** Users sign in through a single-tenant Entra registration that requires assignment. Only users with an app role can reach the app.

| App role | Can |
|---|---|
| GeoBasin user | Sign in and ask questions. |
| GeoBasin owner | Also publish uploads, approve live-lane extractions and roll back reviews. |
| GeoBasin tools | Call the tool server. Held only by the hosted agents. |

Each site deployment rotates the registration's client secret and the run-ticket key. The scripts never print or store either one.

## Network

- **Single entry.** Azure Front Door Premium is the only public entry. Its web application firewall runs in prevention mode with Microsoft's default rule set and bot manager rule set, a per-client rate limit, a separate limit for map tiles, and a rule set that strips identity headers a caller might try to forge.
- **Private Link.** Front Door reaches the Container Apps environment only over Private Link. The environment's public network access is off.
- **Private endpoints.** Storage (with its queues and tables) and Key Vault are reachable only through private endpoints in the platform's virtual network.
- **Network security perimeter.** The agents' Cosmos DB and Storage accept traffic only through a perimeter that admits managed identities from the same subscription. An optional, temporary rule can admit an operator's address during verification.
- **Foundry and AI Search.** These keep public endpoints protected by Entra ID, which stays within Foundry's supported standard setup without virtual network injection. If your policy requires private endpoints for these services, follow Microsoft's guidance on private networking for agents. This adds network infrastructure.

## Data protection and secrets

- Data at rest is encrypted with platform-managed keys. All traffic uses TLS 1.2 or later.
- The only secrets are the sign-in client secret and the run-ticket key, plus the optional Esri key. They are Container Apps secrets created at deployment, never written to disk or source control.
- Key Vault is available, private and RBAC-only, for any further operator-managed secrets.
- Agent conversations, definitions, files and vector stores stay in your own Cosmos DB, Storage and AI Search, through Foundry's standard agent setup. Calls that need no history set `store` to false, so no response is kept.
- Model deployments use Data Zone Standard, which keeps processing within the data zone of the account's region.
- By default, logs do not record request bodies, prompts or answers.

## Malware scanning

Nothing unscanned is ever read or published.

| Path | Control |
|---|---|
| Uploads | Files land in a quarantine container. Microsoft Defender for Storage scans each file on upload. The app refuses all uploads while scanning is off. |
| Live lane | Each fetched file is checked against its registered checksum, then scanned by the platform's own ClamAV scanner: a hash-locked container that refreshes its signatures every six hours. The scanner refuses to give a verdict if its signatures are older than 72 hours. Only clean bytes are copied, once, to the approved container. |

Turning off the live lane's ClamAV gate (`GBX_LIVE_SCAN=false`) or Defender scanning (`GBX_MALWARE_SCAN=false`) is a risk decision that your organization should record. The registered checksums still bind every fetched file.

## Agents and the tool server

- **One door to data.** Agents reach data only through the API's read-only MCP tool server. It refuses browsers and any caller not on its allowlist.
- **Two checks per call.** The server accepts a call only with both the hosted agent's Entra token and a valid run ticket.
- **Run ticket.** Signed with HMAC-SHA256 under a key only the API holds. It lives at most 15 minutes, names the user and their place limits, and travels in a header that the model never sees. The tool server applies the user's limits, access filters and license filters to every call, and records it.
- **No free-form queries.** Graph tools fill fixed, parameterized templates with cleaned names. Every tool has its own time limit.
- **Per-user sessions.** Foundry keeps each user's sessions separate because the app tells it whom each run is for. The app uses the user's object ID from the sign-in layer, never from the browser, through a custom role with only that one data action.
- **User permissions in Fabric.** When the user's own token is available, Fabric IQ answers with the user's permissions, not the app's.

## Licensing and data provenance

- Every source carries its publisher, license and attribution from the source manifest into every citation and export.
- A **license gate** in the build withholds any source whose reuse terms are not confirmed, together with every value derived from it. Neither the bundled data nor the answers redistribute content without permission.
- `tools/check-public-data.mjs` runs in CI. It uses one-way fingerprints to confirm that no withheld text has found its way back into the bundled packs. [DATA_SOURCES.md](DATA_SOURCES.md) lists the sources and their terms.
- New sources join the live lane only through the registry, with a pinned checksum and a recorded license basis. They are published only after an expert approves the extraction.
- Lineage records each step from the publisher's package to the index and the answer. Microsoft Purview can catalog it when the governance template is deployed.

## Responsible AI

The system lets people see why an answer says what it says, and it prefers silence to invention.

- **Cited.** Every statement cites a passage, page, figure or dataset row.
- **Independently checked.** A validator from a different model family checks each statement against the evidence actually retrieved.
- **Transparent.** Statements the critic or validator cannot support are removed and shown as removed, with who removed them and why. Every answer shows its citations and a trace of the specialists and models that produced it.
- **Honest.** When the evidence is silent, the answer is "Not found". When a check cannot finish, the answer is "Validation incomplete".
- **Checkable readings.** Values read from documents and images carry a confidence. Low-confidence values wait for expert review. Page images stay beside the values read from them.
- **People in charge.** Experts approve extractions before publication. In the Co-Scientist, the user, never an agent, records the verdict.
- **Gated models.** The model router's approved model set is the gate that every new model must pass.
- **Measured.** The evaluation workspace measures answer quality against a benchmark, so changes to models or prompts are judged on evidence.

Answers support professional judgment. They do not replace it. Organizations that deploy the platform should say so in their own guidance to users.

## Monitoring and response

- Application Insights and Log Analytics collect telemetry from the app, the jobs and the hosted agents, including a trace of each agent run and the model that served each step.
- Alerts fire on spikes in authentication failures, throttling or server errors, and on the logging limit.
- Budgets warn as spend approaches plan. The kill switch turns off every model call at once.
- Front Door logs record web application firewall decisions. The network security perimeter's access logs record every access to the agents' data.

## Decisions for each deployment

Some choices belong to the deploying organization, not to the templates. Record each one in your risk register.

| Decision | Options |
|---|---|
| Network for Foundry and AI Search | Public endpoints protected by Entra ID, or private networking for agents |
| Region and data zone | Determines where models process data |
| Malware gates | Both on (the default), or a recorded exception |
| Microsoft Purview | Deploy for catalog and lineage, or not |
| App roles | Who gets the user and owner roles |
| Tenant-wide consent | Who may grant the consent that Fabric IQ on behalf of a user requires |
| Router models | Which models are approved |

## Preview features

Some capabilities the solution uses may be in preview, including Fabric ontologies, graph models and the graph query API, Fabric IQ, and Foundry hosted agents. Preview features have supplemental terms, are not intended for production use and may change ([Fabric preview information](https://learn.microsoft.com/fabric/fundamentals/preview)). The app wraps them behind one module and degrades gracefully when they are unavailable. A production deployment should track their status.

## Reporting a vulnerability

Please report security concerns privately to the repository owner, not in a public issue.
