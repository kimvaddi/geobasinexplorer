# Deployment

This guide deploys GeoBasin Explorer AI into an Azure subscription:

- **Greenfield:** a new, empty subscription.
- **Brownfield:** a subscription that already has a landing zone, a Fabric capacity or a DNS zone.

There are two infrastructure-as-code paths:

| Path | Location | Notes |
|---|---|---|
| **Bicep** (reference) | [infra/bicep](../infra/bicep) | Deployed phase by phase by [infra/scripts/deploy.sh](../infra/scripts/deploy.sh). |
| **Terraform** | [infra/terraform](../infra/terraform) | The same platform. The same scripts then handle the Entra registration, the Fabric workspace and ontology, and the hosted agents. |

> **Tip:** On your first deployment, run one phase at a time and read its output before you continue. Regions, quotas and preview settings differ between tenants.

## Checklist

1. Install the tools and get the roles listed below.
2. Register the resource providers and request model quota.
3. Prepare a DNS zone for the public site.
4. Copy and fill in the settings file.
5. Run the phases (Bicep or Terraform).
6. Complete the edge cut-over.
7. Load the content and approve the extractions.
8. Run the smoke test.

## Prerequisites

### Tools

| Tool | Version | Needed for |
|---|---|---|
| Azure CLI with Bicep (`az bicep install`) | Current | All deployments |
| Node.js | 22 | Scripts and builds |
| Python | 3.11 or later | Fabric, agents and helper scripts |
| OpenSSL and curl | Any | Keys and checks |
| Terraform | 1.6 or later | Terraform path only |

Images are built in Azure Container Registry, so you do not need Docker.

### Roles

| Where | Role | Why |
|---|---|---|
| Azure subscriptions | **Owner**, or Contributor plus User Access Administrator | The templates assign roles to managed identities. |
| Microsoft Entra ID | **Application Administrator** or **Cloud Application Administrator** | Creates the app's sign-in registration. |
| Microsoft Entra ID | **Global Administrator** or Privileged Role Administrator, once | Grants tenant-wide consent for the delegated Fabric IQ and Foundry permissions. |
| Microsoft Fabric | **Fabric administrator** | Enables the tenant settings in [FABRIC_KNOWLEDGE.md](FABRIC_KNOWLEDGE.md). |
| Microsoft Fabric | **Capacity administrator** (the deployer) | Assigns the workspace to the capacity. |

The capacity administrator must be a **member** of the tenant that holds the subscription. Fabric rejects business-to-business (B2B) guests as capacity administrators, whether they're named by their guest user principal name, their home address or their object ID ([buy Fabric capacity](https://learn.microsoft.com/fabric/enterprise/buy-capacity#buy-an-azure-capacity-sku-for-fabric)). Fabric does accept a service principal's object ID, but only if the tenant lets service principals use Fabric APIs. If you deploy as a guest, you have two choices:

- Ask a member to create the capacity and a workspace on it, make you an admin of that workspace, and then set `GBX_FABRIC_WORKSPACE_ID`.
- Deploy without Fabric (see [Deploying without Fabric](#deploying-without-fabric)).

### Resource providers

A new subscription may not have these providers registered yet:

```bash
for ns in Microsoft.App Microsoft.CognitiveServices Microsoft.Search Microsoft.Storage Microsoft.KeyVault \
  Microsoft.ContainerRegistry Microsoft.Cdn Microsoft.Network Microsoft.Maps Microsoft.Fabric Microsoft.DocumentDB \
  Microsoft.Insights Microsoft.OperationalInsights Microsoft.Security Microsoft.Logic Microsoft.ManagedIdentity \
  Microsoft.Consumption Microsoft.AlertsManagement; do az provider register --namespace "$ns"; done
```

The optional `geo` phase registers `Microsoft.Orbital` for the GeoCatalog itself. The optional `governance` phase needs `Microsoft.Purview`.

### Model quota

The platform uses Data Zone Standard model deployments:

- **Agents' Foundry account:** the model router (300,000 tokens per minute by default), a validator model and an embedding model.
- **Platform Foundry account:** an answer model, a validator model and an embedding model for the live lane.

Request Data Zone Standard quota for each model in your region before you deploy, or lower the capacities in the templates. Model names and versions are parameters: `routerModels`, and the deployments in `infra/bicep/modules/ai.bicep` and `infra/bicep/agents/modules/foundry-account.bicep`.

If one subscription lacks quota, put the agents in a second subscription with `GBX_AGENTS_SUBSCRIPTION_ID`. Throttling appears as HTTP 429 responses. Azure enforces each deployment's rate limit over short windows as well as per minute ([understanding rate limits](https://learn.microsoft.com/azure/foundry/openai/how-to/quota#understanding-rate-limits)).

### Domain

The public site needs an Azure DNS zone that you control, delegated from your registrar or a parent zone. Example: zone `geobasin.contoso.com` with host `www.geobasin.contoso.com`. The edge phase creates the zone if it does not exist and prints its name servers for delegation.

### Cost

Most fixed cost comes from the Fabric capacity, Azure AI Search, Front Door Premium, Defender for Storage malware scanning and the always-on Container Apps replicas. Model spend depends on use and is bounded by the limits in [Spend controls](#spend-controls). Set the budgets in the settings file before you deploy.

## Greenfield or brownfield

**Greenfield.** Every phase creates what it needs, including the Fabric capacity and workspace.

**Brownfield.** Adapt the same phases to what you already have:

| You already have | Setting or action |
|---|---|
| Model quota in another subscription | `GBX_AGENTS_SUBSCRIPTION_ID` |
| A Fabric capacity | `GBX_FABRIC_CAPACITY_CREATE=false` and `GBX_FABRIC_CAPACITY_NAME` |
| A Fabric workspace | `GBX_FABRIC_WORKSPACE_ID` |
| An Azure DNS zone | Move or create it in the edge resource group (`rg-geobasin-edge` by default). |
| Capacities paused overnight | `GBX_FABRIC_RESUME=true` adds a morning resume job. |
| A Terraform mandate | Use the Terraform path and import existing resources. |
| A hub network in `10.60.0.0/24` | Change the range in [infra/bicep/modules/network.bicep](../infra/bicep/modules/network.bicep) before you deploy. Peer to your hub afterward if you need private access from on-premises. |

The foundation creates its own resource groups (prefix `rg-geobasin-`) and its own virtual network.

## Settings

All deployment-specific values live in one file, `infra/config/environment.env`, which git ignores:

```bash
cp infra/config/environment.example.env infra/config/environment.env
```

To reproduce the reference deployment instead, start from `infra/config/live-equivalent.example.env`. [Matching the reference deployment](#matching-the-reference-deployment) explains what it changes.

The template explains each setting. At minimum, set:

- the tenant and subscription, and the region;
- the operator's object ID (`az ad signed-in-user show --query id -o tsv`);
- an alert email;
- the DNS zone, the site host and the site URL;
- the Fabric capacity name and its administrators.

Values discovered during deployment, such as the sign-in app ID, the Fabric item IDs and the agents' identities, go to `infra/config/environment.generated.env`. This lets you rerun any phase on its own.

## The Bicep path

`infra/scripts/deploy.sh <phase>` runs one phase. `infra/scripts/deploy.sh all` runs every phase from `foundation` to `edge` in order, including `geo` and `governance` when `GBX_DEPLOY_GEO` or `GBX_DEPLOY_GOVERNANCE` is `true`. It finishes by listing the steps that need a person: the edge cut-over, the graph model's first opening in the Fabric portal and the `content` phase. Set `GBX_WHATIF=1` to preview every template deployment without applying it.

| Phase | What it does |
|---|---|
| `foundation` | Resource groups, network, private DNS and endpoints, storage, Key Vault, the platform Foundry account with its runtime and build projects and models, Document Intelligence, Azure AI Search, Azure Maps, monitoring, alerts, the budget, policy assignments, managed identities, role assignments and the Container Apps environment (public access off) |
| `images` | Builds `gbx-api`, `gbx-pipeline`, `gbx-spatial` and `gbx-scanner` with ACR tasks and records the release tag |
| `platform` | The spatial service, the ingestion and evaluation jobs, the live lane's connect and process jobs, and the ClamAV scanner with its signature updates |
| `geo` | Optional. A Planetary Computer Pro GeoCatalog in `GBX_GEO_LOCATION` (North Central US by default), its read-only relay identity, and the Copernicus DEM and Sentinel-2 items over the Cooper Basin copied from the open Planetary Computer ([planetary_load.py](../infra/scripts/planetary_load.py)). Records the settings that turn on the map's overlays at the next site deployment. |
| `governance` | Optional. A Microsoft Purview account in `GBX_GOVERNANCE_LOCATION` (West US by default) for catalog and lineage |
| `agents` | The agents' Foundry account in the standard agent setup: model router, validator and embedding deployments, Cosmos DB, Storage and Search for agent data, capability hosts, the network security perimeter and the budget |
| `fabric` | The Fabric capacity (unless you bring one), the knowledge workspace and, optionally, the morning resume job |
| `knowledge` | The full ingestion framework build: data bundle ([KNOWLEDGE_INPUTS.md](../ingestion-framework/docs/KNOWLEDGE_INPUTS.md)), producers, lakehouse tables, ontology, graph model and verification. Records the item IDs and adds the Fabric IQ connection to the agents' project. On a first build it records the graph model and continues, because the graph loads only after its first opening in the Fabric portal. |
| `signin` | The web app's single-tenant Entra registration, with its app roles, scope and assignments |
| `site` | Builds and deploys the web app with a new sign-in secret and run-ticket key |
| `hosted` | Deploys the two hosted agents and the `gbx-knowledge` toolbox, records the agents' identities, and redeploys the site so it trusts them |
| `edge` | DNS zone, Front Door Premium, the web application firewall, managed certificates and Private Link |
| `content` | Builds the evidence index and the packaged reference index, then seeds the source registry and lands every public source inside the virtual network, and lists the few sources a person lands by hand |
| `smoke` | Checks the Foundry setup and the public site |

A typical first run:

```bash
az login --tenant <tenant id>
infra/scripts/deploy.sh all              # foundation to edge; prints what still needs a person
# open the new graph model once in the Fabric portal, then:
infra/scripts/deploy.sh knowledge
# complete the edge cut-over below, then:
infra/scripts/deploy.sh content          # then land the listed sources by hand, and review and approve the extractions
infra/scripts/deploy.sh smoke
```

The smoke test's last check starts an agent conversation and reads it back from the agents' Cosmos DB. That database sits in a network security perimeter that admits only Agent Service and the managed identities of its own subscription, so the check gets HTTP 403 from your machine. To run it, set `GBX_OPERATOR_CIDRS` to your public address, rerun `infra/scripts/deploy.sh agents smoke`, then clear the setting and run `agents` once more. Behind a corporate VPN that is the VPN's egress address.

## Edge cut-over

Front Door reaches the app only over Private Link. The first rollout takes three steps:

1. Deploy the edge with `GBX_EDGE_CUTOVER=false`. Delegate the DNS zone to the name servers the phase prints. Wait until both custom domains (the site host and the zone apex) show as validated in Front Door.
2. Approve Front Door's pending Private Link connection on the Container Apps environment. Use the environment's **Networking** settings in the Azure portal, or `az network private-endpoint-connection approve`.
3. Set `GBX_EDGE_CUTOVER=true` and rerun `infra/scripts/deploy.sh edge`. This points the site host and the apex at Front Door.

Front Door issues and renews the managed certificates. The apex certificate depends on its validation record, which the template maintains.

## Content and expert review

A new deployment starts with an empty library. `infra/scripts/deploy.sh content`:

1. creates the evidence index (`gbx-evidence-v2`) and builds the packaged reference index (`gbx-passages`) that the agents' packaged-evidence search reads. Azure AI Search and Foundry take Entra-authenticated calls on their public endpoints, so this runs on your machine with the operator's roles;
2. seeds the live lane's source registry from [services/api/src/live/pipeline-registry.ts](../services/api/src/live/pipeline-registry.ts);
3. lands every source listed in `GBX_LIVE_SOURCES` that its publisher serves to programs: each file is fetched from its publisher, checked against its registered checksum, scanned, read with Document Intelligence and extracted.

Steps 2 and 3 write to the platform's private storage, so they run inside the virtual network as executions of the `gbx-connect` job, with the pipeline's own identity, through [live_content.py](../infra/scripts/live_content.py). No network exception for your machine is needed. Several sources land at a time (`GBX_CONTENT_PARALLEL`, 4 by default); a source that fails is reported at the end instead of stopping the others, and rerunning the phase retries it.

Three registered sources are served by their publishers only to a browser, so the phase lists them with their pinned checksums for you to land by hand: the Marabooka 1 well completion report and the Habanero 1 well files from PEPS SA, and the GDA2020 Technical Manual. Download each one, build the Habanero 1 archive with [pipeline/bundle_habanero.py](../pipeline/bundle_habanero.py), and land it through the site's owner upload route:

```bash
python3 infra/scripts/live_content.py plan                                  # the hand-landed sources and where to get them
python3 infra/scripts/live_content.py land peps-sa-marabooka-1 ~/Downloads/Marabooka1_report.pdf
```

`land` checks the file against its pinned checksum first, then sends it with your Azure CLI sign-in to the site's API, where the same checksum, scan and processing apply. It needs the site to answer at `GBX_SITE_URL`, so it comes after the edge cut-over, and it needs the GeoBasin owner role, which the `signin` phase gives the operator.

Each extraction then waits for a user with the GeoBasin owner role. The owner reviews it in the app, corrects low-confidence values and approves it. Approval publishes the source to the index and the manifest.

When the library is published:

1. Release the live lane's serving agent as the live-lane README describes (`agent-release.mjs --release <version> --create`).
2. Set `GBX_LIVE_AGENT_NAME` and `GBX_LIVE_AGENT_VERSION`.
3. Rerun `infra/scripts/deploy.sh platform site knowledge`. The `knowledge` phase then adds the library's sources and documents to the knowledge model.

## The library in OneLake

`infra/scripts/deploy.sh library` brings the library into Microsoft Fabric while the storage account stays closed, and publishes the search index from gold with the OneLake files indexer ([LIBRARY_ONELAKE.md](LIBRARY_ONELAKE.md)). It does the following:

1. Gives the knowledge workspace a workspace identity.
2. Admits that identity through a resource instance rule on the storage account, and lets it read only `raw`, `processed` and `manifests`.
3. Creates the lakehouse `geobasin_library_lh` with three shortcuts.
4. Deploys the silver, gold and extract notebooks and the publish pipeline.
5. Prepares the OneLake files indexer.

Run it any time after the `fabric` phase. Before the first approval it only wires everything up. After each approval, rerun it: it builds silver and gold, runs the indexer, checks every passage against the push index, and moves the gold pointer. The first time a run passes, it also redeploys the site so that live answers read from gold.

The next `foundation` deployment keeps the resource instance rule, because `main.bicepparam` passes `GBX_FABRIC_WORKSPACE_ID` to the storage module.

## Deploying without Fabric

Set `GBX_FABRIC_ENABLED=false` when the tenant can't give you an F-SKU Fabric capacity, for example when you're a guest there. `all` then skips the `fabric` and `knowledge` phases, and `library` does nothing.

Everything else deploys as usual:

- the platform and live lane;
- the agents' Foundry account;
- sign-in and the site with its tool server;
- the hosted scientists and the edge.

The scientists run without the Fabric IQ toolbox. They answer from the library's passages and say that structured knowledge is unavailable, exactly as they do when the capacity is paused. To add Fabric later, set the flag back to `true` and run `infra/scripts/deploy.sh fabric knowledge hosted library`.

## Matching the reference deployment

[`infra/config/live-equivalent.example.env`](../infra/config/live-equivalent.example.env) reproduces the reference deployment. Compared with the default settings, it:

- deploys the `geo` and `governance` phases, so the map offers the Planetary Computer overlays and the deployment has a Purview account;
- runs the platform's validator at 300 and its embeddings at 1,000 thousand tokens a minute;
- resumes the Fabric capacity at 06:00 Central each morning;
- builds the full knowledge model, including the World Stress Map, once you download it ([KNOWLEDGE_INPUTS.md](../ingestion-framework/docs/KNOWLEDGE_INPUTS.md)).

It keeps the same 77 public sources, the `all` route for live questions, the F8 capacity and the agents' models and capacities as the defaults. It also keeps the safety settings at their defaults: Defender malware scanning and the ClamAV gate stay on, and the daily caps on questions and tokens stay bounded. Change them only after your own security and cost review. Two things stay yours: Esri base maps need your own ArcGIS key (`infra/scripts/esri-key.sh` stores it as a secret after the `site` phase), and the app wears the brand pack you choose (`GBX_BRAND`).

## The Terraform path

[infra/terraform](../infra/terraform) provisions the foundation, the agents' Foundry account, the Fabric capacity, the workloads and the edge with the azurerm and azapi providers, at the same API versions as the Bicep templates. Apply it in passes, because the workloads need images and an Entra registration that Terraform does not create:

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars          # fill it in
terraform init && terraform apply                      # foundation, agents, Fabric capacity
cd ../.. && echo 'GBX_IAC=terraform' >> infra/config/environment.env
infra/scripts/deploy-platform.sh build                 # prints the release tag
infra/scripts/deploy.sh fabric knowledge signin        # workspace, ontology and graph, sign-in registration
export TF_VAR_site_app_secret="$(az ad app credential reset --id <site app id> --append --query password -o tsv)"
export TF_VAR_run_ticket_key="$(openssl rand -base64 32)"
cd infra/terraform && terraform apply -var deploy_workloads=true -var release_tag=<tag> -var site_app_id=<id> \
  -var fabric_workspace_id=<id> -var fabric_ontology_id=<id> -var fabric_graph_model_id=<id>
```

Then:

1. Deploy the hosted agents with `python3 services/scientists/deploy_hosted.py`, using the settings that `deploy.sh hosted` would export.
2. Add the agents' identities with `-var 'agent_identities=["<id>","<id>"]'`.
3. Run the grant scripts in `infra/scripts` for the site's agent and Fabric identities.
4. Apply with `-var deploy_edge=true`, and cut over as described in [Edge cut-over](#edge-cut-over).

With `GBX_IAC=terraform`, the scripts read Terraform's outputs, which use the same names as the Bicep outputs.

> **Important:** Configure a remote backend before any shared or production use. The state holds secrets, such as the sign-in secret and the Application Insights connection string. Protect it accordingly.

## Spend controls

| Control | Setting | Effect |
|---|---|---|
| Question and token limits | `GBX_QUESTIONS_PER_DAY`, `GBX_TOKENS_PER_DAY` | Daily and monthly limits, overall and per user, enforced before any model call |
| Document Intelligence limits | `GBX_CAP_OCR_PAGES`, `GBX_CAP_OCR_PAGES_MONTH` | Daily and monthly page limits (500 and 5,000 by default) |
| Budgets | `GBX_BUDGET_AMOUNT`, `GBX_AGENTS_BUDGET_AMOUNT` | Email alerts at 50, 75 and 90 percent of actual spend, and at 100 percent of forecast spend, for the platform subscription and the agents' resource group |
| Kill switch | `GBX_AI_ENABLED=false` | Turns off every model call at once. Answers then come from prepared rules or say "Not found". |
| Router rate limit | Router deployment | Bounds burst usage in tokens per minute |
| Fabric capacity | Pause it | The app degrades gracefully while the capacity is paused. |

## Release and rollback

- **Release.** Build new images with `infra/scripts/deploy.sh images`, deploy them with `platform` and `site`, and update the agents with `hosted`. A new agent version is created only when the code or definition changed.
- **Secrets.** Each site deployment rotates the sign-in secret and the run-ticket key.
- **App rollback.** Container Apps keeps previous revisions. Redeploy the previous image tag (`GBX_SITE_TAG` and `GBX_RELEASE_TAG` in the generated settings).
- **Knowledge rollback.** The previous knowledge run stays published until a new run succeeds.
- **Library rollback.** A published source can return to an earlier extraction version without deleting anything.

## Tear down

1. Delete the resource groups the deployment created. The default names are `rg-geobasin-app`, `-ai`, `-data`, `-ops`, `-maps`, `-edge`, `-v2-ai` and `-fabric`, plus `-geo` and `-governance` if you deployed them.
2. Delete the Entra app registration and the Fabric workspace.
3. Purge soft-deleted Key Vaults and AI services accounts if you plan to redeploy soon with the same names.

With Terraform, `terraform destroy` removes what Terraform created. Remove the workspace and the registration separately.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every answer says "Validation incomplete" | The router or validator is throttled (HTTP 429 in Application Insights) | Add quota or raise the deployment capacity. |
| Knowledge cards say they come from the snapshot | The Fabric capacity is paused | `python3 infra/scripts/fabric_capacity.py resume` |
| The graph model has no data after the first build, or the `knowledge` phase says it is published but not loaded | The graph model was never opened in the portal | Open it once in the Fabric portal, then rerun the `knowledge` phase. |
| `content` lists sources that did not land | The publisher refused or was slow, or the source is served only to a browser | Rerun `deploy.sh content` to retry; land browser-only sources with `live_content.py land`. Each attempt's log is in `ContainerAppConsoleLogs_CL` for the `gbx-connect` job. |
| The site is unreachable after the edge phase | Domains not validated, Private Link not approved, or cut-over not applied | Complete the three [edge cut-over](#edge-cut-over) steps. |
| The stratigraphy specialist never uses Fabric IQ | Missing consent, unpublished ontology or no read access | Grant tenant-wide consent, publish the ontology and give the user read access in Fabric. |
| `content` stops with `connect ETIMEDOUT` to the search service | Your machine's network, often a corporate VPN, can't reach that Azure AI Search address | Run the phase from Azure Cloud Shell, or from a machine whose network reaches the search endpoint. The landing itself runs inside the virtual network either way. |
| Every landed source fails processing with "A current exact clean verdict is required" | The ClamAV scanner had no signatures yet (`missing-or-unsafe-database-main` in the scan log) | The `platform` phase now fetches them once. On an older deployment, start the `gbx-sigs` job once, then rerun `deploy.sh content` to land and scan the sources again. |
| `site` or `hosted` stops after building the image | The tenant's app management policy caps client secret lifetimes | The `site` phase uses the longest lifetime the tenant accepts and says when to redeploy; set `GBX_SITE_SECRET_DAYS` to choose it. |
| The `fabric` phase fails with "Invalid principal name" or "All administrators must belong to the same tenant" | The capacity administrator is a B2B guest | Use a member of the tenant (see [Roles](#roles)), or set `GBX_FABRIC_ENABLED=false`. |
