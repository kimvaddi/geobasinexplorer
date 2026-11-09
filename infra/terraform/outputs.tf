output "suffix" {
  description = "Suffix of the platform resource names."
  value       = local.sfx
}

output "acr_login_server" {
  value = azurerm_container_registry.acr.login_server
}

output "storage_account" {
  value = azurerm_storage_account.st.name
}

output "foundry_endpoint" {
  description = "Version 1 Foundry account (runtime and build projects, live lane)."
  value       = "https://${azapi_resource.foundry.name}.services.ai.azure.com"
}

output "search_endpoint" {
  value = "https://${azurerm_search_service.search.name}.search.windows.net"
}

output "docintel_endpoint" {
  value = "https://${azurerm_cognitive_account.docintel.custom_subdomain_name}.cognitiveservices.azure.com/"
}

output "v2_project_endpoint" {
  description = "Version 2 Foundry project for the hosted scientists (GBX_V2_PROJECT_ENDPOINT)."
  value       = "https://${azapi_resource.v2_account.name}.services.ai.azure.com/api/projects/${azapi_resource.v2_project.name}"
}

output "site_fqdn" {
  description = "The web app's Container Apps address (reachable through Front Door only)."
  value       = var.deploy_workloads ? azurerm_container_app.site[0].ingress[0].fqdn : ""
}

output "site_agents_principal_id" {
  description = "Identity the site uses to call the scientists (infra/scripts/grant-agent-caller.sh)."
  value       = azurerm_user_assigned_identity.workload["site-agents"].principal_id
}

output "site_fabric_principal_id" {
  description = "Identity the site uses to read the knowledge graph (infra/scripts/grant-fabric-reader.sh)."
  value       = azurerm_user_assigned_identity.workload["site-fabric"].principal_id
}

output "dns_name_servers" {
  description = "Delegate the zone to these name servers."
  value       = var.deploy_edge ? azurerm_dns_zone.zone[0].name_servers : []
}

output "front_door_endpoint" {
  value = var.deploy_edge ? azurerm_cdn_frontdoor_endpoint.endpoint[0].host_name : ""
}

# The same names the Bicep deployments output, so infra/scripts/lib.sh can read either (GBX_IAC=terraform).
output "foundation" {
  sensitive = true
  value = {
    suffix                      = local.sfx
    environmentName             = azurerm_container_app_environment.cae.name
    environmentDefaultDomain    = azurerm_container_app_environment.cae.default_domain
    appInsightsConnectionString = azurerm_application_insights.appi.connection_string
    acrLoginServer              = azurerm_container_registry.acr.login_server
    acrName                     = azurerm_container_registry.acr.name
    webIdentityId               = azurerm_user_assigned_identity.id["web"].id
    webClientId                 = azurerm_user_assigned_identity.id["web"].client_id
    ingestIdentityId            = azurerm_user_assigned_identity.id["ingest"].id
    ingestClientId              = azurerm_user_assigned_identity.id["ingest"].client_id
    storageAccountName          = azurerm_storage_account.st.name
    keyVaultName                = azurerm_key_vault.kv.name
    foundryName                 = azapi_resource.foundry.name
    foundryEndpoint             = "https://${azapi_resource.foundry.name}.services.ai.azure.com"
    searchName                  = azurerm_search_service.search.name
    searchEndpoint              = "https://${azurerm_search_service.search.name}.search.windows.net"
    docIntelEndpoint            = "https://${azurerm_cognitive_account.docintel.custom_subdomain_name}.cognitiveservices.azure.com/"
    actionGroupId               = azurerm_monitor_action_group.alerts.id
    mapsAccountName             = azapi_resource.maps.name
    mapsAccountClientId         = azapi_resource.maps.output.properties.uniqueId
    mapsIdentityId              = azurerm_user_assigned_identity.id["maps"].id
    mapsIdentityClientId        = azurerm_user_assigned_identity.id["maps"].client_id
    spatialIdentityId           = azurerm_user_assigned_identity.id["spatial"].id
  }
}

output "agents" {
  value = {
    resourceGroup   = azurerm_resource_group.v2.name
    accountName     = azapi_resource.v2_account.name
    projectName     = azapi_resource.v2_project.name
    projectEndpoint = "https://${azapi_resource.v2_account.name}.services.ai.azure.com/api/projects/${azapi_resource.v2_project.name}"
  }
}
