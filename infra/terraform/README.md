# Terraform

This configuration provisions GeoBasin Explorer AI with Terraform, for organizations that standardize on it. It mirrors the Bicep templates in [../bicep](../bicep), which remain the reference implementation: the azurerm provider manages the mainstream resources, and the azapi provider manages Microsoft Foundry accounts, projects, deployments, connections and capability hosts, the Fabric capacity, the network security perimeter, the WAF policy and the Container Apps sign-in configuration, at the same API versions the Bicep uses. Role assignments use built-in role definition IDs rather than names, so a renamed role never breaks a deployment.

| File | Contents |
|---|---|
| `versions.tf` | Providers, with a second azurerm alias for an optional agents subscription, and a commented remote backend |
| `variables.tf` | Every setting, with descriptions and safe defaults |
| `main.tf` | The foundation: resource groups, network, private DNS and endpoints, storage, Key Vault, monitoring, budget, registry, identities, the Container Apps environment, the platform Foundry account and models, Document Intelligence, Azure AI Search, Azure Maps and role assignments |
| `agents.tf` | The agents' Foundry account in the standard agent setup, the model router and other deployments, agent data stores, connections including Fabric IQ, capability hosts, data-plane grants, the network security perimeter and the budget |
| `fabric.tf` | The Fabric capacity |
| `workloads.tf` | The web app with its sign-in, the spatial service and the jobs (ingestion, evaluation, live connect and process, scanner and signatures) |
| `edge.tf` | The DNS zone, Front Door Premium, the WAF, custom domains, rules, the route, the security policy and the cut-over DNS records |
| `outputs.tf` | Outputs, including `foundation` and `agents` maps with the same names as the Bicep outputs, which the scripts read when `GBX_IAC=terraform` |

## Applying it

Apply in passes, because the workloads need container images and an Entra registration that Terraform does not create. [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-terraform-path) gives the full sequence.

```bash
cp terraform.tfvars.example terraform.tfvars    # fill it in; secrets go in TF_VAR_ environment variables
terraform init
terraform apply                                  # pass one: foundation, agents, Fabric capacity
# build images, create the sign-in registration and build the knowledge model with infra/scripts (GBX_IAC=terraform)
terraform apply -var deploy_workloads=true ...   # pass two: the web app and jobs
terraform apply -var deploy_edge=true ...        # pass three: the public edge, then cut over
```

Configure a remote backend before shared use, and protect the state, which holds the sign-in secret and connection strings. `terraform fmt -check` and `terraform validate` run in CI.
