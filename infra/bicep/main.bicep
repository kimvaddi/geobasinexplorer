// GeoBasin Explorer AI foundation: resource groups, network, data, AI services, operations, Azure Maps, policy, private
// endpoints, role assignments and the Container Apps environment. Deploy at subscription scope (infra/scripts/deploy.sh
// foundation runs this with the values in infra/config/environment.env):
//   az deployment sub create -l <region> -n gbx-foundation -f infra/bicep/main.bicep -p infra/bicep/main.bicepparam
targetScope = 'subscription'

@description('Region for every regional GeoBasin resource. Choose one that offers Azure AI Foundry, Azure AI Search, Document Intelligence and Container Apps, and ideally your Fabric capacity.')
param location string = 'westus3'

@description('Object ID of the operator (a person or a deployment principal) who runs the one-time bootstrap and data load; it receives operator data-plane roles.')
param operatorObjectId string

@description('Email that receives budget and service alerts.')
param alertEmail string

@description('Monthly budget ceiling in the billing currency.')
param budgetAmount int = 1500

@description('First day of the budget period, yyyy-MM-01 (the current or a later month).')
param budgetStartDate string

@description('Region for the Azure Maps account. Azure Maps is offered in fewer regions than the rest of the platform, so it has its own setting.')
param mapsLocation string = 'westus2'

@description('Public origin of the web app (https://<your host>), a browser origin allowed to use the Maps account.')
param publicOrigin string

@description('Other browser origins allowed to use the Maps account, for example a second site or a test host.')
param additionalOrigins array = []

@description('Value of the owner tag on every resource.')
param ownerTag string = 'platform-team'

@description('Thousands of tokens a minute for the platform Foundry account\'s answer, validator and embedding deployments (Data Zone Standard quota must cover them).')
param answerCapacity int = 100
param validatorCapacity int = 100
param embedCapacity int = 300

var tags = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: ownerTag
  costCenter: 'unassigned'
  dataClassification: 'public'
}
var sfx = take(uniqueString(subscription().id, 'geobasin'), 6)

resource rgApp 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-app'
  location: location
  tags: union(tags, { layer: 'app' })
}
resource rgAi 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-ai'
  location: location
  tags: union(tags, { layer: 'ai' })
}
resource rgData 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-data'
  location: location
  tags: union(tags, { layer: 'data' })
}
resource rgOps 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-ops'
  location: location
  tags: union(tags, { layer: 'ops' })
}
// Front Door, its WAF and the Azure DNS zone of the public domain (edge.bicep; deploy.sh edge creates the zone).
resource rgEdge 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-edge'
  location: location
  tags: union(tags, { layer: 'edge' })
}
// Only the Azure Maps account lives here (see mapsLocation).
resource rgMaps 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-maps'
  location: mapsLocation
  tags: union(tags, { layer: 'maps' })
}

module ops 'modules/ops.bicep' = {
  scope: rgOps
  name: 'gbx-ops'
  params: { location: location, tags: union(tags, { layer: 'ops' }), sfx: sfx, alertEmail: alertEmail }
}

module data 'modules/data.bicep' = {
  scope: rgData
  name: 'gbx-data'
  params: { location: location, tags: union(tags, { layer: 'data' }), sfx: sfx }
}

module ai 'modules/ai.bicep' = {
  scope: rgAi
  name: 'gbx-ai'
  params: { location: location, tags: union(tags, { layer: 'ai' }), sfx: sfx, answerCapacity: answerCapacity, validatorCapacity: validatorCapacity, embedCapacity: embedCapacity }
}

module network 'modules/network.bicep' = {
  scope: rgApp
  name: 'gbx-network'
  params: { location: location, tags: union(tags, { layer: 'app' }) }
}

module privateEndpoints 'modules/private-endpoints.bicep' = {
  scope: rgData
  name: 'gbx-private-endpoints'
  params: {
    location: location
    tags: union(tags, { layer: 'data' })
    storageAccountName: data.outputs.storageAccountName
    peSubnetId: network.outputs.peSubnetId
    zoneIds: { blob: network.outputs.blobZoneId, queue: network.outputs.queueZoneId, table: network.outputs.tableZoneId }
  }
}

module app 'modules/app.bicep' = {
  scope: rgApp
  name: 'gbx-app'
  params: {
    location: location
    tags: union(tags, { layer: 'app' })
    sfx: sfx
    logAnalyticsName: ops.outputs.logAnalyticsName
    logAnalyticsRg: rgOps.name
    infrastructureSubnetId: network.outputs.caeSubnetId
  }
}

// Data-plane and pull roles: web identity reads, ingestion identity writes, operator bootstraps.
module rolesAi 'modules/roles-ai.bicep' = {
  scope: rgAi
  name: 'gbx-roles-ai'
  params: {
    foundryName: ai.outputs.foundryName
    docIntelName: ai.outputs.docIntelName
    searchName: ai.outputs.searchName
    webPrincipalId: app.outputs.webPrincipalId
    ingestPrincipalId: app.outputs.ingestPrincipalId
    operatorObjectId: operatorObjectId
  }
}
module rolesData 'modules/roles-data.bicep' = {
  scope: rgData
  name: 'gbx-roles-data'
  params: {
    storageAccountName: data.outputs.storageAccountName
    keyVaultName: data.outputs.keyVaultName
    webPrincipalId: app.outputs.webPrincipalId
    ingestPrincipalId: app.outputs.ingestPrincipalId
    operatorObjectId: operatorObjectId
  }
}

module maps 'modules/maps.bicep' = {
  scope: rgMaps
  name: 'gbx-maps'
  params: {
    location: mapsLocation
    tags: union(tags, { layer: 'maps' })
    sfx: sfx
    readers: [ { id: app.outputs.mapsPrincipalId, type: 'ServicePrincipal' }, { id: operatorObjectId, type: 'User' } ]
    allowedOrigins: filter(concat([ publicOrigin ], additionalOrigins), o => !empty(o))
  }
}

// The Maps group's location policy allows its own region instead of the workload region.
module mapsPolicy 'modules/policy.bicep' = {
  scope: rgMaps
  name: 'gbx-policy-rg-geobasin-maps'
  params: { location: mapsLocation }
}

module policy 'modules/policy.bicep' = [for rg in [ rgApp.name, rgAi.name, rgData.name, rgOps.name, rgEdge.name ]: {
  scope: resourceGroup(rg)
  name: 'gbx-policy-${rg}'
  params: { location: location, isAi: rg == rgAi.name, isData: rg == rgData.name }
}]

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'budget-geobasin-monthly'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual50: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 50, thresholdType: 'Actual', contactEmails: [ alertEmail ] }
      actual75: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 75, thresholdType: 'Actual', contactEmails: [ alertEmail ] }
      actual90: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 90, thresholdType: 'Actual', contactEmails: [ alertEmail ] }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: [ alertEmail ] }
    }
  }
}

output suffix string = sfx
output environmentName string = app.outputs.environmentName
output environmentStaticIp string = app.outputs.environmentStaticIp
output environmentDefaultDomain string = app.outputs.environmentDefaultDomain
output customDomainVerificationId string = app.outputs.customDomainVerificationId
output appInsightsConnectionString string = ops.outputs.appInsightsConnectionString
output keyVaultUri string = data.outputs.keyVaultUri
output acrLoginServer string = app.outputs.acrLoginServer
output acrName string = app.outputs.acrName
output webIdentityId string = app.outputs.webIdentityId
output ingestIdentityId string = app.outputs.ingestIdentityId
output webClientId string = app.outputs.webClientId
output ingestClientId string = app.outputs.ingestClientId
output keyVaultName string = data.outputs.keyVaultName
output storageAccountName string = data.outputs.storageAccountName
output foundryName string = ai.outputs.foundryName
output foundryEndpoint string = ai.outputs.foundryEndpoint
output searchName string = ai.outputs.searchName
output searchEndpoint string = ai.outputs.searchEndpoint
output docIntelEndpoint string = ai.outputs.docIntelEndpoint
output actionGroupId string = ops.outputs.actionGroupId
output mapsAccountName string = maps.outputs.accountName
output mapsAccountClientId string = maps.outputs.accountClientId
output mapsIdentityId string = app.outputs.mapsIdentityId
output mapsIdentityClientId string = app.outputs.mapsIdentityClientId
output spatialIdentityId string = app.outputs.spatialIdentityId
