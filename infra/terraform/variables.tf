variable "subscription_id" {
  description = "Subscription for the platform (the rg-geobasin-* resource groups)."
  type        = string
}

variable "agents_subscription_id" {
  description = "Optional second subscription for the version 2 Foundry account and the Fabric capacity; empty uses subscription_id."
  type        = string
  default     = ""
}

variable "location" {
  description = "Region for every regional resource; it must offer Foundry hosted agents, the model router on Data Zone Standard, Azure AI Search, Document Intelligence, Container Apps and Fabric."
  type        = string
  default     = "westus3"
}

variable "maps_location" {
  description = "Region for the Azure Maps account."
  type        = string
  default     = "westus2"
}

variable "operator_object_id" {
  description = "Object ID of the operator (person or deployment principal) who bootstraps data and verifies the setup."
  type        = string
}

variable "operator_principal_type" {
  description = "User for a person, ServicePrincipal for a deployment pipeline's identity."
  type        = string
  default     = "User"
}

variable "alert_email" {
  description = "Email that receives budget and service alerts."
  type        = string
}

variable "owner_tag" {
  description = "Value of the owner tag."
  type        = string
  default     = "platform-team"
}

variable "budget_amount" {
  description = "Monthly budget for the platform subscription."
  type        = number
  default     = 1500
}

variable "agents_budget_amount" {
  description = "Monthly budget for the version 2 Foundry resource group."
  type        = number
  default     = 300
}

variable "budget_start_date" {
  description = "First day of the budget period, yyyy-MM-01T00:00:00Z (the current or a later month)."
  type        = string
}

# ---- Public address --------------------------------------------------------------------------------------------------
variable "dns_zone" {
  description = "Azure DNS zone of the public domain (created in rg-geobasin-edge when deploy_edge is true)."
  type        = string
}

variable "site_host" {
  description = "Host people use, for example www.<dns_zone>; the zone apex redirects to it."
  type        = string
}

variable "additional_origins" {
  description = "Other browser origins allowed to use Azure Maps."
  type        = list(string)
  default     = []
}

# ---- Models ----------------------------------------------------------------------------------------------------------
variable "answer_model" {
  description = "Version 1 answer model deployment (gbx-answer) in the platform Foundry account."
  type        = object({ format = string, name = string, version = string, capacity = number })
  default     = { format = "OpenAI", name = "gpt-6-astra", version = "2026-09-03", capacity = 150 }
}

variable "validator_model" {
  description = "Independent validator deployment (gbx-validator and gbx2-validator), a different model family from the writer."
  type        = object({ format = string, name = string, version = string, capacity = number })
  default     = { format = "xAI", name = "grok-4-1-fast-reasoning", version = "1", capacity = 150 }
}

variable "embed_model" {
  description = "Embedding deployment (gbx-embed and gbx2-embed)."
  type        = object({ format = string, name = string, version = string, capacity = number })
  default     = { format = "OpenAI", name = "text-embedding-3-large", version = "1", capacity = 100 }
}

variable "router_capacity" {
  description = "Model router capacity in thousands of tokens per minute (Data Zone Standard)."
  type        = number
  default     = 300
}

variable "router_models" {
  description = "Models the model router may choose from: at least two, and never an xAI model (docs/FOUNDRY_AGENTS.md)."
  type        = list(object({ format = string, name = string, version = string }))
  default = [
    { format = "OpenAI", name = "gpt-6-astra", version = "2026-09-03" },
    { format = "OpenAI", name = "gpt-5.6-sol", version = "2026-07-09" },
    { format = "OpenAI", name = "gpt-5.6-terra", version = "2026-07-09" },
    { format = "OpenAI", name = "gpt-5.4-mini", version = "2026-03-17" },
  ]
}

variable "search_sku" {
  description = "Azure AI Search tier for the evidence index."
  type        = string
  default     = "basic"
}

# ---- Microsoft Fabric ------------------------------------------------------------------------------------------------
variable "fabric_capacity_create" {
  description = "Create a Fabric capacity (greenfield); false when you bring your own."
  type        = bool
  default     = true
}

variable "fabric_capacity_name" {
  description = "Fabric capacity name: 3 to 63 lower-case letters and digits, starting with a letter."
  type        = string
}

variable "fabric_capacity_sku" {
  description = "Fabric SKU, for example F8."
  type        = string
  default     = "F8"
}

variable "fabric_admins" {
  description = "Capacity administrators: user principal names for people, object IDs for service principals."
  type        = list(string)
  default     = []
}

variable "fabric_workspace_id" {
  description = "Knowledge workspace ID (infra/scripts/fabric_workspace.py ensure prints it); empty until the workspace exists."
  type        = string
  default     = ""
}

variable "fabric_graph_model_id" {
  description = "Graph model ID behind the scientists' typed knowledge tools; empty until the ingestion framework has built it."
  type        = string
  default     = ""
}

variable "fabric_ontology_id" {
  description = "Ontology ID that Fabric IQ answers from; empty until the ingestion framework has built it."
  type        = string
  default     = ""
}

# ---- Workloads (second apply, after the images exist) ----------------------------------------------------------------
variable "deploy_workloads" {
  description = "Deploy the container apps and jobs. Leave false on the first apply, build the images (infra/scripts/deploy-platform.sh build), then set true."
  type        = bool
  default     = false
}

variable "release_tag" {
  description = "Tag printed by infra/scripts/deploy-platform.sh build (gbx-pipeline, gbx-spatial and gbx-scanner share it)."
  type        = string
  default     = ""
}

variable "brand" {
  description = "Brand pack the app image was built with (gbx-api:<release_tag>-<brand>)."
  type        = string
  default     = "geobasin"
}

variable "site_app_id" {
  description = "Client ID of the web app's sign-in registration (infra/scripts/site-signin.sh)."
  type        = string
  default     = ""
}

variable "site_app_secret" {
  description = "Client secret of that registration. Pass it through TF_VAR_site_app_secret; never commit it."
  type        = string
  default     = ""
  sensitive   = true
}

variable "run_ticket_key" {
  description = "Key that signs the run tickets between the app and the scientists (openssl rand -base64 32). Pass it through TF_VAR_run_ticket_key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "agent_identities" {
  description = "Object IDs of the hosted agents' identities (deploy_hosted.py --identities); empty until they exist."
  type        = list(string)
  default     = []
}

variable "ai_enabled" {
  type    = bool
  default = true
}

variable "malware_scan" {
  type    = bool
  default = true
}

variable "live_scan" {
  type    = bool
  default = true
}

variable "questions_per_day" {
  type    = number
  default = 5000
}

variable "tokens_per_day" {
  type    = number
  default = 50000000
}

variable "live_sources" {
  description = "Comma-separated source ids the live lane serves (infra/config/environment.example.env lists them)."
  type        = string
  default     = ""
}

variable "live_route" {
  type    = string
  default = "matched"
}

variable "live_agent_name" {
  type    = string
  default = ""
}

variable "live_agent_version" {
  type    = string
  default = ""
}

# ---- Edge ------------------------------------------------------------------------------------------------------------
variable "deploy_edge" {
  description = "Deploy Front Door, the WAF and the public domain. Set true once the site runs."
  type        = bool
  default     = false
}

variable "edge_cutover" {
  description = "Point the DNS records at Front Door once both domains validate and the Private Link connection is approved."
  type        = bool
  default     = false
}
