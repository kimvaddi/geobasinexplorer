// App foundation: container registry, workload identities and the Container Apps environment (Consumption only).
// The web app and the ingestion job are deployed later by apps.bicep, once the image, caps and sign-in are ready.
// The environment takes no public traffic: Front Door Premium reaches it over Private Link (edge.bicep), which
// Container Apps only accepts while public network access is disabled.
param location string
param tags object
param sfx string
param logAnalyticsName string
param logAnalyticsRg string

@description('Subnet for the Container Apps environment (delegated to Microsoft.App/environments).')
param infrastructureSubnetId string

resource law 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  scope: resourceGroup(logAnalyticsRg)
  name: logAnalyticsName
}

resource acr 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'acrgbx${sfx}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource idWeb 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gbx-web'
  location: location
  tags: tags
}
resource idIngest 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gbx-ingest'
  location: location
  tags: tags
}
// Used only to obtain Azure Maps tokens for signed-in users; it holds nothing but the Maps render role.
resource idMaps 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gbx-maps'
  location: location
  tags: tags
}
// The spatial service's identity: it pulls its image and nothing else.
resource idSpatial 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gbx-spatial'
  location: location
  tags: tags
}

var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
resource pullWeb 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, idWeb.id, acrPull)
  properties: { roleDefinitionId: acrPull, principalId: idWeb.properties.principalId, principalType: 'ServicePrincipal' }
}
resource pullIngest 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, idIngest.id, acrPull)
  properties: { roleDefinitionId: acrPull, principalId: idIngest.properties.principalId, principalType: 'ServicePrincipal' }
}
resource pullSpatial 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, idSpatial.id, acrPull)
  properties: { roleDefinitionId: acrPull, principalId: idSpatial.properties.principalId, principalType: 'ServicePrincipal' }
}

resource cae 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: 'cae-gbx-${sfx}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        sharedKey: law.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [ { name: 'Consumption', workloadProfileType: 'Consumption' } ]
    vnetConfiguration: { infrastructureSubnetId: infrastructureSubnetId, internal: false }
    zoneRedundant: false
    publicNetworkAccess: 'Disabled'
  }
}

output environmentName string = cae.name
// The public IP appears only after the first app with external ingress is created; read it again then.
output environmentStaticIp string = cae.properties.?staticIp ?? ''
output environmentDefaultDomain string = cae.properties.defaultDomain
output customDomainVerificationId string = cae.properties.?customDomainConfiguration.?customDomainVerificationId ?? ''
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output webIdentityId string = idWeb.id
output ingestIdentityId string = idIngest.id
output webClientId string = idWeb.properties.clientId
output ingestClientId string = idIngest.properties.clientId
output webPrincipalId string = idWeb.properties.principalId
output ingestPrincipalId string = idIngest.properties.principalId
output mapsIdentityId string = idMaps.id
output mapsIdentityClientId string = idMaps.properties.clientId
output mapsPrincipalId string = idMaps.properties.principalId
output spatialIdentityId string = idSpatial.id
