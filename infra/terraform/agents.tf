# Version 2: the Foundry account for the scientist agents in the standard agent setup (conversations, files and vector
# stores in your own Cosmos DB, Storage and AI Search), the model router, the validator and the embedding deployments,
# the Fabric IQ connection, capability hosts, data-plane roles, a network security perimeter and a budget. Mirrors
# infra/bicep/agents/foundry.bicep and its modules.
locals {
  sfx2      = substr(sha1("${local.agents_sub}geobasin-v2"), 0, 6)
  v2_tags   = merge(local.tags, { layer = "ai", version = "2" })
  v2_role   = { for k, v in merge(local.role, local.v2_extra_roles) : k => "/subscriptions/${local.agents_sub}/providers/Microsoft.Authorization/roleDefinitions/${v}" }
  fabric_iq = var.fabric_workspace_id != "" && var.fabric_ontology_id != "" ? "https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/${var.fabric_workspace_id}/items/${var.fabric_ontology_id}/ontologyEndpoint" : ""
}

resource "azurerm_resource_group" "v2" {
  provider = azurerm.agents
  name     = "rg-geobasin-v2-ai"
  location = var.location
  tags     = local.v2_tags
}

resource "azurerm_log_analytics_workspace" "v2" {
  provider            = azurerm.agents
  name                = "log-gbx2-${local.sfx2}"
  location            = var.location
  resource_group_name = azurerm_resource_group.v2.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.v2_tags
}

resource "azurerm_application_insights" "v2" {
  provider            = azurerm.agents
  name                = "appi-gbx2-${local.sfx2}"
  location            = var.location
  resource_group_name = azurerm_resource_group.v2.name
  workspace_id        = azurerm_log_analytics_workspace.v2.id
  application_type    = "web"
  tags                = local.v2_tags
}

resource "azapi_resource" "v2_cosmos" {
  type      = "Microsoft.DocumentDB/databaseAccounts@2024-11-15"
  parent_id = azurerm_resource_group.v2.id
  name      = "cosmos-gbx2-${local.sfx2}"
  location  = var.location
  tags      = local.v2_tags
  body = {
    kind = "GlobalDocumentDB"
    properties = {
      databaseAccountOfferType = "Standard"
      consistencyPolicy        = { defaultConsistencyLevel = "Session" }
      locations                = [{ locationName = var.location, failoverPriority = 0, isZoneRedundant = false }]
      disableLocalAuth         = true
      publicNetworkAccess      = "SecuredByPerimeter"
    }
  }
  response_export_values = ["properties.documentEndpoint"]
}

resource "azapi_resource" "v2_storage" {
  type      = "Microsoft.Storage/storageAccounts@2023-05-01"
  parent_id = azurerm_resource_group.v2.id
  name      = "stgbx2${local.sfx2}"
  location  = var.location
  tags      = local.v2_tags
  body = {
    kind = "StorageV2"
    sku  = { name = "Standard_ZRS" }
    properties = {
      allowSharedKeyAccess  = false
      allowBlobPublicAccess = false
      minimumTlsVersion     = "TLS1_2"
      publicNetworkAccess   = "SecuredByPerimeter"
      networkAcls           = { bypass = "None", defaultAction = "Deny" }
    }
  }
  response_export_values = ["properties.primaryEndpoints.blob"]
}

resource "azurerm_search_service" "v2" {
  provider                      = azurerm.agents
  name                          = "srch-gbx2-${local.sfx2}"
  resource_group_name           = azurerm_resource_group.v2.name
  location                      = var.location
  sku                           = "basic"
  local_authentication_enabled  = false
  public_network_access_enabled = true
  tags                          = local.v2_tags
}

resource "azapi_resource" "v2_account" {
  type      = "Microsoft.CognitiveServices/accounts@2025-10-01-preview"
  parent_id = azurerm_resource_group.v2.id
  name      = "aif-gbx2-${local.sfx2}"
  location  = var.location
  tags      = local.v2_tags
  identity { type = "SystemAssigned" }
  body = {
    kind = "AIServices"
    sku  = { name = "S0" }
    properties = {
      customSubDomainName    = "aif-gbx2-${local.sfx2}"
      allowProjectManagement = true
      publicNetworkAccess    = "Enabled"
      networkAcls            = { defaultAction = "Allow", virtualNetworkRules = [], ipRules = [] }
      disableLocalAuth       = true
    }
  }
}

resource "azapi_resource" "v2_router" {
  type      = "Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview"
  parent_id = azapi_resource.v2_account.id
  name      = "gbx2-router"
  body = {
    sku = { name = "DataZoneStandard", capacity = var.router_capacity }
    properties = {
      model   = { format = "OpenAI", name = "model-router", version = "2025-11-18" }
      routing = { mode = "balanced", models = var.router_models }
    }
  }
  schema_validation_enabled = false
}

resource "azapi_resource" "v2_validator" {
  type      = "Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview"
  parent_id = azapi_resource.v2_account.id
  name      = "gbx2-validator"
  body = {
    sku        = { name = "DataZoneStandard", capacity = var.validator_model.capacity }
    properties = { model = { format = var.validator_model.format, name = var.validator_model.name, version = var.validator_model.version } }
  }
  depends_on = [azapi_resource.v2_router]
}

resource "azapi_resource" "v2_embed" {
  type      = "Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview"
  parent_id = azapi_resource.v2_account.id
  name      = "gbx2-embed"
  body = {
    sku        = { name = "DataZoneStandard", capacity = var.embed_model.capacity }
    properties = { model = { format = var.embed_model.format, name = var.embed_model.name, version = var.embed_model.version } }
  }
  depends_on = [azapi_resource.v2_validator]
}

resource "azapi_resource" "v2_project" {
  type      = "Microsoft.CognitiveServices/accounts/projects@2025-10-01-preview"
  parent_id = azapi_resource.v2_account.id
  name      = "geobasin-v2"
  location  = var.location
  identity { type = "SystemAssigned" }
  body                   = { properties = { displayName = "GeoBasin Explorer AI version 2", description = "The scientists' hosted agents, toolbox and evaluations." } }
  response_export_values = ["properties.internalId"]
  depends_on             = [azapi_resource.v2_embed]
}

locals {
  v2_project_principal = azapi_resource.v2_project.identity[0].principal_id
  v2_internal          = azapi_resource.v2_project.output.properties.internalId
  v2_workspace_id      = "${substr(local.v2_internal, 0, 8)}-${substr(local.v2_internal, 8, 4)}-${substr(local.v2_internal, 12, 4)}-${substr(local.v2_internal, 16, 4)}-${substr(local.v2_internal, 20, 12)}"
  v2_connections = {
    cosmos  = { name = azapi_resource.v2_cosmos.name, category = "CosmosDB", target = azapi_resource.v2_cosmos.output.properties.documentEndpoint, id = azapi_resource.v2_cosmos.id }
    storage = { name = azapi_resource.v2_storage.name, category = "AzureStorageAccount", target = azapi_resource.v2_storage.output.properties.primaryEndpoints.blob, id = azapi_resource.v2_storage.id }
    search  = { name = azurerm_search_service.v2.name, category = "CognitiveSearch", target = "https://${azurerm_search_service.v2.name}.search.windows.net", id = azurerm_search_service.v2.id }
  }
}

resource "azapi_resource" "v2_connection" {
  for_each  = local.v2_connections
  type      = "Microsoft.CognitiveServices/accounts/projects/connections@2025-10-01-preview"
  parent_id = azapi_resource.v2_project.id
  name      = each.value.name
  body = {
    properties = {
      category = each.value.category
      target   = each.value.target
      authType = "AAD"
      metadata = { ApiType = "Azure", ResourceId = each.value.id, location = var.location }
    }
  }
}

# Fabric IQ as the signed-in person (docs/FOUNDRY_AGENTS.md): created once the ontology exists.
resource "azapi_resource" "v2_fabric_iq" {
  count     = local.fabric_iq == "" ? 0 : 1
  type      = "Microsoft.CognitiveServices/accounts/projects/connections@2025-10-01-preview"
  parent_id = azapi_resource.v2_project.id
  name      = "fabriciq-geobasin-knowledge"
  body = {
    properties = {
      category      = "RemoteTool"
      target        = local.fabric_iq
      authType      = "UserEntraToken"
      isSharedToAll = false
      metadata      = { description = "Fabric IQ ontology geobasin_knowledge, asked as the signed-in person" }
      audience      = "https://analysis.windows.net/powerbi/api"
      scopes        = ["https://analysis.windows.net/powerbi/api/Item.Execute.All", "https://analysis.windows.net/powerbi/api/Item.Read.All"]
    }
  }
  schema_validation_enabled = false
}

resource "azapi_resource" "v2_appinsights_connection" {
  type      = "Microsoft.CognitiveServices/accounts/connections@2025-10-01-preview"
  parent_id = azapi_resource.v2_account.id
  name      = "${azapi_resource.v2_account.name}-appinsights"
  body = {
    properties = {
      category      = "AppInsights"
      target        = azurerm_application_insights.v2.id
      authType      = "ApiKey"
      isSharedToAll = true
      credentials   = { key = azurerm_application_insights.v2.connection_string }
      metadata      = { ApiType = "Azure", ResourceId = azurerm_application_insights.v2.id }
    }
  }
  depends_on = [azapi_resource.v2_project]
}

# The project's identity reaches its agent data before the capability hosts are created (official sample order).
resource "azurerm_role_assignment" "v2_project" {
  provider = azurerm.agents
  for_each = {
    storage_blob   = { scope = azapi_resource.v2_storage.id, role = "blob_contributor" }
    cosmos_op      = { scope = azapi_resource.v2_cosmos.id, role = "cosmos_operator" }
    search_data    = { scope = azurerm_search_service.v2.id, role = "search_contributor" }
    search_service = { scope = azurerm_search_service.v2.id, role = "search_service" }
    law_reader     = { scope = azurerm_application_insights.v2.id, role = "log_analytics_reader" }
    monitoring     = { scope = azurerm_application_insights.v2.id, role = "privileged_monitoring_reader" }
  }
  scope              = each.value.scope
  role_definition_id = local.v2_role[each.value.role]
  principal_id       = local.v2_project_principal
  principal_type     = "ServicePrincipal"
}

locals {
  v2_extra_roles = {
    cosmos_operator              = "230815da-be43-4aae-9cb4-875f7bd000aa"
    log_analytics_reader         = "73c42c96-874c-492b-b04d-ab87d138a893"
    privileged_monitoring_reader = "dbc9c667-e97f-4491-aee6-90b9cf960190"
  }
}

resource "azurerm_role_assignment" "v2_operator" {
  provider           = azurerm.agents
  scope              = azapi_resource.v2_account.id
  role_definition_id = local.v2_role.foundry_user
  principal_id       = var.operator_object_id
  principal_type     = var.operator_principal_type
}

resource "azapi_resource" "v2_account_host" {
  type       = "Microsoft.CognitiveServices/accounts/capabilityHosts@2025-10-01-preview"
  parent_id  = azapi_resource.v2_account.id
  name       = "caphost-account"
  body       = { properties = { capabilityHostKind = "Agents" } }
  depends_on = [azurerm_role_assignment.v2_project, azapi_resource.v2_connection]
}

resource "azapi_resource" "v2_project_host" {
  type      = "Microsoft.CognitiveServices/accounts/projects/capabilityHosts@2025-10-01-preview"
  parent_id = azapi_resource.v2_project.id
  name      = "caphost-project"
  body = {
    properties = {
      capabilityHostKind       = "Agents"
      threadStorageConnections = [azapi_resource.v2_connection["cosmos"].name]
      storageConnections       = [azapi_resource.v2_connection["storage"].name]
      vectorStoreConnections   = [azapi_resource.v2_connection["search"].name]
    }
  }
  schema_validation_enabled = false
  depends_on                = [azapi_resource.v2_account_host]
}

# After the capability hosts: Blob Data Owner only on the project's own *-azureml-agent containers, and Cosmos DB
# Built-in Data Contributor on the database enterprise_memory (official sample, Set up standard agent resources).
resource "azurerm_role_assignment" "v2_agent_blobs" {
  provider           = azurerm.agents
  scope              = azapi_resource.v2_storage.id
  role_definition_id = local.v2_role.blob_data_owner
  principal_id       = local.v2_project_principal
  principal_type     = "ServicePrincipal"
  condition_version  = "2.0"
  condition          = "((!(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/read'}) AND !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/filter/action'}) AND !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringStartsWithIgnoreCase '${local.v2_workspace_id}' AND @Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringLikeIgnoreCase '*-azureml-agent'))"
  depends_on         = [azapi_resource.v2_project_host]
}

resource "azapi_resource" "v2_agent_database" {
  type      = "Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15"
  parent_id = azapi_resource.v2_cosmos.id
  name      = uuidv5("url", "${azapi_resource.v2_cosmos.id}/${local.v2_project_principal}/enterprise_memory")
  body = {
    properties = {
      principalId      = local.v2_project_principal
      roleDefinitionId = "${azapi_resource.v2_cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
      scope            = "${azapi_resource.v2_cosmos.id}/dbs/enterprise_memory"
    }
  }
  depends_on = [azapi_resource.v2_project_host]
}

# Network security perimeter: Cosmos DB and Storage take traffic only from managed identities in this subscription.
resource "azapi_resource" "v2_perimeter" {
  type      = "Microsoft.Network/networkSecurityPerimeters@2025-05-01"
  parent_id = azurerm_resource_group.v2.id
  name      = "nsp-gbx2-${local.sfx2}"
  location  = var.location
  tags      = local.v2_tags
  body      = { properties = {} }
}

resource "azapi_resource" "v2_perimeter_profile" {
  type      = "Microsoft.Network/networkSecurityPerimeters/profiles@2025-05-01"
  parent_id = azapi_resource.v2_perimeter.id
  name      = "agent-data"
  body      = { properties = {} }
}

resource "azapi_resource" "v2_perimeter_rule" {
  type      = "Microsoft.Network/networkSecurityPerimeters/profiles/accessRules@2025-05-01"
  parent_id = azapi_resource.v2_perimeter_profile.id
  name      = "subscription-managed-identities"
  body      = { properties = { direction = "Inbound", subscriptions = [{ id = "/subscriptions/${local.agents_sub}" }] } }
}

resource "azapi_resource" "v2_perimeter_association" {
  for_each = {
    "agent-conversations" = { id = azapi_resource.v2_cosmos.id, mode = "Enforced" }
    "agent-files"         = { id = azapi_resource.v2_storage.id, mode = "Enforced" }
    "foundry-account"     = { id = azapi_resource.v2_account.id, mode = "Learning" }
  }
  type      = "Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2025-05-01"
  parent_id = azapi_resource.v2_perimeter.id
  name      = each.key
  body = {
    properties = {
      privateLinkResource = { id = each.value.id }
      profile             = { id = azapi_resource.v2_perimeter_profile.id }
      accessMode          = each.value.mode
    }
  }
  depends_on = [azapi_resource.v2_perimeter_rule]
}

resource "azurerm_consumption_budget_resource_group" "v2" {
  provider          = azurerm.agents
  name              = "gbx2-monthly"
  resource_group_id = azurerm_resource_group.v2.id
  amount            = var.agents_budget_amount
  time_grain        = "Monthly"
  time_period {
    start_date = var.budget_start_date
  }
  dynamic "notification" {
    for_each = { 50 = "Actual", 75 = "Actual", 90 = "Actual", 100 = "Forecasted" }
    content {
      enabled        = true
      threshold      = tonumber(notification.key)
      operator       = "GreaterThanOrEqualTo"
      threshold_type = notification.value
      contact_emails = [var.alert_email]
    }
  }
}
