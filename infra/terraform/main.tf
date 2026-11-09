data "azurerm_client_config" "current" {}
data "azurerm_subscription" "platform" {}

locals {
  sfx         = substr(sha1("${var.subscription_id}geobasin"), 0, 6)
  agents_sub  = coalesce(var.agents_subscription_id, var.subscription_id)
  site_url    = "https://${var.site_host}"
  tags        = { workload = "geobasin-explorer-ai", environment = "prototype", owner = var.owner_tag, costCenter = "unassigned", dataClassification = "public" }
  storage_dns = ["privatelink.blob.core.windows.net", "privatelink.queue.core.windows.net", "privatelink.table.core.windows.net"]
  # Built-in role definition IDs (the same in every tenant), so a renamed role never breaks an assignment.
  role = {
    blob_contributor   = "ba92f5b4-2d11-453d-a403-e96b0029c9fe"
    blob_reader        = "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"
    queue_sender       = "c6a89b2d-59bc-44d0-9896-0f6e12d7b80a"
    queue_processor    = "8a0f0c08-91a1-4084-bc3d-661d67233fed"
    queue_reader       = "19e7f393-937e-4f77-808e-94535e297925"
    table_contributor  = "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"
    kv_secrets_user    = "4633458b-17de-408a-b874-0445c86b69e6"
    openai_user        = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
    cognitive_user     = "a97b65f3-24c7-4388-baec-2e87135dc908"
    search_reader      = "1407120a-92aa-4202-b7e9-c0e197c71c8f"
    search_contributor = "8ebe5a00-799e-43f5-93ac-243d3dce84a7"
    search_service     = "7ca78c08-252a-4471-8644-bb5ff32d4ba0"
    acr_pull           = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
    foundry_user       = "53ca6127-db72-4b80-b1b0-d745d6d5456d"
    blob_data_owner    = "b7e6dc6d-f1e8-4753-8033-0f276bb0955b"
  }
  role_id = { for k, v in local.role : k => "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${v}" }
}

# ---- Resource groups -------------------------------------------------------------------------------------------------
resource "azurerm_resource_group" "rg" {
  for_each = { app = var.location, ai = var.location, data = var.location, ops = var.location, edge = var.location, maps = var.maps_location }
  name     = "rg-geobasin-${each.key}"
  location = each.value
  tags     = merge(local.tags, { layer = each.key })
}

# ---- Network: a small VNet for the Container Apps environment and the storage private endpoints ------------------------
resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-gbx"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg["app"].name
  address_space       = ["10.60.0.0/24"]
  tags                = local.tags
}

resource "azurerm_subnet" "cae" {
  name                 = "snet-cae"
  resource_group_name  = azurerm_resource_group.rg["app"].name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.60.0.0/25"]
  delegation {
    name = "containerapps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "pe" {
  name                              = "snet-pe"
  resource_group_name               = azurerm_resource_group.rg["app"].name
  virtual_network_name              = azurerm_virtual_network.vnet.name
  address_prefixes                  = ["10.60.0.128/27"]
  private_endpoint_network_policies = "Disabled"
}

resource "azurerm_network_security_group" "nsg" {
  for_each            = { cae = azurerm_subnet.cae.id, pe = azurerm_subnet.pe.id }
  name                = "vnet-gbx-snet-${each.key}-nsg-${var.location}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg["app"].name
  tags                = local.tags
}

resource "azurerm_subnet_network_security_group_association" "nsg" {
  for_each                  = { cae = azurerm_subnet.cae.id, pe = azurerm_subnet.pe.id }
  subnet_id                 = each.value
  network_security_group_id = azurerm_network_security_group.nsg[each.key].id
}

resource "azurerm_private_dns_zone" "storage" {
  for_each            = toset(local.storage_dns)
  name                = each.value
  resource_group_name = azurerm_resource_group.rg["app"].name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "storage" {
  for_each              = azurerm_private_dns_zone.storage
  name                  = "link-vnet-gbx"
  resource_group_name   = azurerm_resource_group.rg["app"].name
  private_dns_zone_name = each.value.name
  virtual_network_id    = azurerm_virtual_network.vnet.id
}

# ---- Data: private storage (uploads, extractions, run registers) and Key Vault ----------------------------------------
resource "azurerm_storage_account" "st" {
  name                            = "stgbx${local.sfx}"
  resource_group_name             = azurerm_resource_group.rg["data"].name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false
  public_network_access_enabled   = false
  tags                            = merge(local.tags, { layer = "data" })
  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
  }
}

resource "azurerm_storage_container" "c" {
  for_each           = toset(["quarantine", "raw", "processed"])
  name               = each.value
  storage_account_id = azurerm_storage_account.st.id
}

resource "azapi_resource" "queue" {
  for_each  = toset(["ingest-jobs"])
  type      = "Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01"
  parent_id = "${azurerm_storage_account.st.id}/queueServices/default"
  name      = each.value
  body      = { properties = {} }
}

resource "azapi_resource" "table" {
  for_each  = toset(["reviews", "feedback", "ingestjobs", "usage"])
  type      = "Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01"
  parent_id = "${azurerm_storage_account.st.id}/tableServices/default"
  name      = each.value
  body      = { properties = {} }
}

# Malware scanning on upload (Microsoft Defender for Storage); the app refuses uploads while it is off.
resource "azapi_resource" "defender_storage" {
  count     = var.malware_scan ? 1 : 0
  type      = "Microsoft.Security/defenderForStorageSettings@2025-06-01"
  parent_id = azurerm_storage_account.st.id
  name      = "current"
  body = {
    properties = {
      isEnabled                         = true
      overrideSubscriptionLevelSettings = true
      malwareScanning                   = { onUpload = { isEnabled = true, capGBPerMonth = 100 } }
      sensitiveDataDiscovery            = { isEnabled = false }
    }
  }
}

resource "azurerm_private_endpoint" "st" {
  for_each            = { blob = "privatelink.blob.core.windows.net", queue = "privatelink.queue.core.windows.net", table = "privatelink.table.core.windows.net" }
  name                = "pe-${azurerm_storage_account.st.name}-${each.key}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg["app"].name
  subnet_id           = azurerm_subnet.pe.id
  tags                = local.tags
  private_service_connection {
    name                           = "plsc-${each.key}"
    private_connection_resource_id = azurerm_storage_account.st.id
    subresource_names              = [each.key]
    is_manual_connection           = false
  }
  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [azurerm_private_dns_zone.storage[each.value].id]
  }
}

resource "azurerm_key_vault" "kv" {
  name                          = "kv-gbx-${local.sfx}"
  location                      = var.location
  resource_group_name           = azurerm_resource_group.rg["data"].name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 7
  public_network_access_enabled = false
  tags                          = merge(local.tags, { layer = "data" })
}

# ---- Operations: logs, telemetry, alerts and the budget ---------------------------------------------------------------
resource "azurerm_log_analytics_workspace" "law" {
  name                = "log-gbx-${local.sfx}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg["ops"].name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 1
  tags                = merge(local.tags, { layer = "ops" })
}

resource "azurerm_application_insights" "appi" {
  name                = "appi-gbx-${local.sfx}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg["ops"].name
  workspace_id        = azurerm_log_analytics_workspace.law.id
  application_type    = "web"
  tags                = merge(local.tags, { layer = "ops" })
}

resource "azurerm_monitor_action_group" "alerts" {
  name                = "ag-gbx-alerts"
  resource_group_name = azurerm_resource_group.rg["ops"].name
  short_name          = "gbxalerts"
  email_receiver {
    name                    = "operator"
    email_address           = var.alert_email
    use_common_alert_schema = true
  }
  tags = local.tags
}

resource "azurerm_consumption_budget_subscription" "budget" {
  name            = "gbx-monthly"
  subscription_id = data.azurerm_subscription.platform.id
  amount          = var.budget_amount
  time_grain      = "Monthly"
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

# ---- Registry, identities and the Container Apps environment ----------------------------------------------------------
resource "azurerm_container_registry" "acr" {
  name                = "acrgbx${local.sfx}"
  resource_group_name = azurerm_resource_group.rg["app"].name
  location            = var.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = merge(local.tags, { layer = "app" })
}

resource "azurerm_user_assigned_identity" "id" {
  for_each            = toset(["web", "ingest", "maps", "spatial"])
  name                = "id-gbx-${each.value}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg["app"].name
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  for_each           = toset(["web", "ingest", "spatial"])
  scope              = azurerm_container_registry.acr.id
  role_definition_id = local.role_id.acr_pull
  principal_id       = azurerm_user_assigned_identity.id[each.value].principal_id
  principal_type     = "ServicePrincipal"
}

# Public network access is off: Front Door reaches the apps over Private Link only (edge.tf).
resource "azurerm_container_app_environment" "cae" {
  name                       = "cae-gbx-${local.sfx}"
  location                   = var.location
  resource_group_name        = azurerm_resource_group.rg["app"].name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
  infrastructure_subnet_id   = azurerm_subnet.cae.id
  public_network_access      = "Disabled"
  tags                       = merge(local.tags, { layer = "app" })
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

# ---- AI services: Foundry (version 1 runtime and build projects), Document Intelligence, Azure AI Search ---------------
resource "azapi_resource" "foundry" {
  type      = "Microsoft.CognitiveServices/accounts@2025-06-01"
  parent_id = azurerm_resource_group.rg["ai"].id
  name      = "aif-gbx-${local.sfx}"
  location  = var.location
  tags      = merge(local.tags, { layer = "ai" })
  identity { type = "SystemAssigned" }
  body = {
    kind = "AIServices"
    sku  = { name = "S0" }
    properties = {
      customSubDomainName    = "aif-gbx-${local.sfx}"
      allowProjectManagement = true
      disableLocalAuth       = true
      publicNetworkAccess    = "Enabled"
    }
  }
  response_export_values = ["properties.endpoint"]
}

resource "azapi_resource" "foundry_project" {
  for_each  = { "geobasin-runtime" = "Runtime answering and validation for GeoBasin Explorer AI.", "geobasin-build" = "Build-time question generation and evaluation; never reads runtime holdouts." }
  type      = "Microsoft.CognitiveServices/accounts/projects@2025-06-01"
  parent_id = azapi_resource.foundry.id
  name      = each.key
  location  = var.location
  identity { type = "SystemAssigned" }
  body = { properties = { description = each.value, displayName = each.key } }
}

resource "azapi_resource" "foundry_deployment" {
  for_each = {
    "gbx-answer"    = var.answer_model
    "gbx-validator" = var.validator_model
    "gbx-embed"     = var.embed_model
  }
  type      = "Microsoft.CognitiveServices/accounts/deployments@2025-06-01"
  parent_id = azapi_resource.foundry.id
  name      = each.key
  body = {
    sku        = { name = "DataZoneStandard", capacity = each.value.capacity }
    properties = { model = { format = each.value.format, name = each.value.name, version = each.value.version } }
  }
  # Deployments on one account are created one at a time.
  depends_on = [azapi_resource.foundry_project]
}

resource "azurerm_cognitive_account" "docintel" {
  name                  = "di-gbx-${local.sfx}"
  location              = var.location
  resource_group_name   = azurerm_resource_group.rg["ai"].name
  kind                  = "FormRecognizer"
  sku_name              = "S0"
  custom_subdomain_name = "di-gbx-${local.sfx}"
  local_auth_enabled    = false
  tags                  = merge(local.tags, { layer = "ai" })
}

resource "azurerm_search_service" "search" {
  name                          = "srch-gbx-${local.sfx}-${var.search_sku}"
  resource_group_name           = azurerm_resource_group.rg["ai"].name
  location                      = var.location
  sku                           = var.search_sku
  local_authentication_enabled  = false
  public_network_access_enabled = true
  tags                          = merge(local.tags, { layer = "ai" })
}

# ---- Azure Maps: Entra-only, browser origins limited to the site ------------------------------------------------------
resource "azapi_resource" "maps" {
  type      = "Microsoft.Maps/accounts@2023-06-01"
  parent_id = azurerm_resource_group.rg["maps"].id
  name      = "maps-gbx-${local.sfx}"
  location  = var.maps_location
  tags      = merge(local.tags, { layer = "maps" })
  body = {
    kind = "Gen2"
    sku  = { name = "G2" }
    properties = {
      disableLocalAuth = true
      cors             = { corsRules = [{ allowedOrigins = concat([local.site_url], var.additional_origins) }] }
    }
  }
  response_export_values = ["properties.uniqueId"]
}

# Render read and nothing else, as the Bicep foundation does.
resource "azurerm_role_definition" "maps_render" {
  name        = "GeoBasin Maps Render Reader (${local.sfx})"
  scope       = azurerm_resource_group.rg["maps"].id
  description = "Read Azure Maps render data (map tiles, styles, fonts and sprites) and nothing else."
  permissions {
    data_actions = ["Microsoft.Maps/accounts/services/render/read"]
  }
  assignable_scopes = [azurerm_resource_group.rg["maps"].id]
}

resource "azurerm_role_assignment" "maps_reader" {
  scope              = azapi_resource.maps.id
  role_definition_id = azurerm_role_definition.maps_render.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.id["maps"].principal_id
  principal_type     = "ServicePrincipal"
}

# ---- Data and AI roles: least privilege for the app, the ingestion job and the operator --------------------------------
locals {
  web    = azurerm_user_assigned_identity.id["web"].principal_id
  ingest = azurerm_user_assigned_identity.id["ingest"].principal_id
  assignments = {
    web_quarantine     = { scope = azurerm_storage_container.c["quarantine"].id, role = "blob_contributor", principal = local.web, type = "ServicePrincipal" }
    web_raw            = { scope = azurerm_storage_container.c["raw"].id, role = "blob_reader", principal = local.web, type = "ServicePrincipal" }
    web_processed      = { scope = azurerm_storage_container.c["processed"].id, role = "blob_reader", principal = local.web, type = "ServicePrincipal" }
    web_queue          = { scope = azapi_resource.queue["ingest-jobs"].id, role = "queue_sender", principal = local.web, type = "ServicePrincipal" }
    web_tables         = { scope = azurerm_storage_account.st.id, role = "table_contributor", principal = local.web, type = "ServicePrincipal" }
    web_kv             = { scope = azurerm_key_vault.kv.id, role = "kv_secrets_user", principal = local.web, type = "ServicePrincipal" }
    web_openai         = { scope = azapi_resource.foundry.id, role = "openai_user", principal = local.web, type = "ServicePrincipal" }
    web_foundry        = { scope = azapi_resource.foundry.id, role = "foundry_user", principal = local.web, type = "ServicePrincipal" }
    web_docintel       = { scope = azurerm_cognitive_account.docintel.id, role = "cognitive_user", principal = local.web, type = "ServicePrincipal" }
    web_search         = { scope = azurerm_search_service.search.id, role = "search_reader", principal = local.web, type = "ServicePrincipal" }
    ingest_quarantine  = { scope = azurerm_storage_container.c["quarantine"].id, role = "blob_contributor", principal = local.ingest, type = "ServicePrincipal" }
    ingest_raw         = { scope = azurerm_storage_container.c["raw"].id, role = "blob_contributor", principal = local.ingest, type = "ServicePrincipal" }
    ingest_processed   = { scope = azurerm_storage_container.c["processed"].id, role = "blob_contributor", principal = local.ingest, type = "ServicePrincipal" }
    ingest_queue_proc  = { scope = azapi_resource.queue["ingest-jobs"].id, role = "queue_processor", principal = local.ingest, type = "ServicePrincipal" }
    ingest_queue_read  = { scope = azapi_resource.queue["ingest-jobs"].id, role = "queue_reader", principal = local.ingest, type = "ServicePrincipal" }
    ingest_queue_send  = { scope = azapi_resource.queue["ingest-jobs"].id, role = "queue_sender", principal = local.ingest, type = "ServicePrincipal" }
    ingest_tables      = { scope = azurerm_storage_account.st.id, role = "table_contributor", principal = local.ingest, type = "ServicePrincipal" }
    ingest_openai      = { scope = azapi_resource.foundry.id, role = "openai_user", principal = local.ingest, type = "ServicePrincipal" }
    ingest_docintel    = { scope = azurerm_cognitive_account.docintel.id, role = "cognitive_user", principal = local.ingest, type = "ServicePrincipal" }
    ingest_search      = { scope = azurerm_search_service.search.id, role = "search_contributor", principal = local.ingest, type = "ServicePrincipal" }
    ingest_search_svc  = { scope = azurerm_search_service.search.id, role = "search_service", principal = local.ingest, type = "ServicePrincipal" }
    operator_blob      = { scope = azurerm_storage_account.st.id, role = "blob_contributor", principal = var.operator_object_id, type = var.operator_principal_type }
    operator_tables    = { scope = azurerm_storage_account.st.id, role = "table_contributor", principal = var.operator_object_id, type = var.operator_principal_type }
    operator_search    = { scope = azurerm_search_service.search.id, role = "search_contributor", principal = var.operator_object_id, type = var.operator_principal_type }
    operator_search_sv = { scope = azurerm_search_service.search.id, role = "search_service", principal = var.operator_object_id, type = var.operator_principal_type }
    operator_foundry   = { scope = azapi_resource.foundry.id, role = "foundry_user", principal = var.operator_object_id, type = var.operator_principal_type }
  }
}

resource "azurerm_role_assignment" "platform" {
  for_each           = local.assignments
  scope              = each.value.scope
  role_definition_id = local.role_id[each.value.role]
  principal_id       = each.value.principal
  principal_type     = each.value.type
}
