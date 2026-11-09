# Infrastructure

Everything needed to deploy GeoBasin Explorer AI to Azure lives here, in two interchangeable forms. [bicep](bicep) holds the reference templates, and [terraform](terraform) provisions the same platform with the azurerm and azapi providers. [scripts](scripts) holds the phase-by-phase deployment script and the helpers for the steps that are not Azure Resource Manager resources: the Entra registration, the Fabric workspace and knowledge build, the hosted agents and their grants. [config/environment.example.env](config/environment.example.env) is the settings file both paths read, and [config/live-equivalent.example.env](config/live-equivalent.example.env) is the same file set up to reproduce the reference deployment. [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) is the step-by-step guide.

## Layout

| Path | What it deploys |
|---|---|
| `bicep/main.bicep` | The foundation at subscription scope: resource groups, network, storage, Key Vault, the platform Foundry account and models, Document Intelligence, Azure AI Search, Azure Maps, monitoring, budget, policy, private endpoints, identities, roles and the Container Apps environment |
| `bicep/apps.bicep` | The GDAL/PROJ spatial service and the ingestion and evaluation jobs |
| `bicep/live.bicep` | The live lane's connect and process jobs, their identity, tables and roles |
| `bicep/pipeline.bicep` | The ClamAV scanner and its signature updater |
| `bicep/site.bicep` | The web app with its sign-in, token store, identities for the agents and for Fabric, tables and error alert |
| `bicep/edge.bicep` | Front Door Premium, the WAF, managed certificates, Private Link and DNS records |
| `bicep/geo.bicep`, `bicep/governance.bicep` | Optional: a Planetary Computer Pro GeoCatalog for map overlays, and Microsoft Purview |
| `bicep/agents/foundry.bicep` | The agents' Foundry account in the standard agent setup, with the model router, validator and embedding deployments, agent data stores, capability hosts, network security perimeter and budget |
| `bicep/agents/fabric-capacity.bicep` | A Fabric capacity for greenfield deployments |
| `bicep/agents/fabric-resume.bicep` | Optional: a Logic App that resumes a capacity paused overnight |
| `terraform/` | The same platform in Terraform; see its README |
| `scripts/deploy.sh` | Runs the deployment phase by phase |
| `scripts/lib.sh` | Loads the settings and reads the deployments' outputs (Bicep or Terraform) |
| `scripts/deploy-platform.sh`, `scripts/deploy-site.sh` | Build images and deploy the platform workloads and the web app |
| `scripts/site-signin.sh` | Creates the web app's Entra registration and assigns its roles |
| `scripts/fabric_workspace.py`, `scripts/fabric_capacity.py` | Create or find the knowledge workspace; show, resume and warm the capacity |
| `scripts/grant-agent-caller.sh`, `grant-fabric-iq.sh`, `grant-fabric-reader.sh` | Least-privilege grants for calling the agents, Fabric IQ as the person, and reading the graph |
| `scripts/foundry_smoke.py` | Checks that the agents' Foundry setup works |
| `scripts/esri-key.sh`, `scripts/planetary_load.py` | Optional map overlays |
| `scripts/live_content.py` | The library's content steps without opening private storage: lands public sources through the in-network `gbx-connect` job, lands browser-only sources through the site's owner route, and saves the published manifest for the knowledge build |
| `config/environment.example.env`, `config/live-equivalent.example.env` | The settings templates: the defaults, and a profile that reproduces the reference deployment |

## Conventions

Every template takes its environment-specific values as parameters, and every parameter file reads them with `readEnvironmentVariable`, so no subscription, tenant, identity or secret is ever written to the repository. Resource names carry a six-character suffix derived from the subscription, which keeps deployments in different subscriptions apart. Keys and local authentication are disabled on every service that allows it, and every workload has its own managed identity with only the roles it needs.
