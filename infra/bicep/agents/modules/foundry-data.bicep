// Agent data resources for the version 2 standard setup (Microsoft Learn, Set up standard agent resources): Cosmos DB
// holds conversations and agent definitions, Storage holds files, and AI Search holds the vector stores the agents
// create. Each accepts only Microsoft Entra ID. Cosmos DB is serverless, which Learn lists as supported, so the prototype
// pays per request instead of reserving 1,000 RU/s for each container. Cosmos DB and Storage are secured by the network
// security perimeter in foundry-perimeter.bicep, as the tenant's Secure Future Initiative policies require; AI Search
// and the Foundry account stay public with Entra sign-in. Application Insights receives the agents'
// OpenTelemetry traces.
param location string
param sfx string
param tags object

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: 'cosmos-gbx2-${sfx}'
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [ { locationName: location, failoverPriority: 0, isZoneRedundant: false } ]
    capabilities: [ { name: 'EnableServerless' } ]
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'SecuredByPerimeter'
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    enableFreeTier: false
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stgbx2${sfx}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_ZRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'SecuredByPerimeter'
    networkAcls: { bypass: 'None', defaultAction: 'Deny' }
  }
}

resource search 'Microsoft.Search/searchServices@2024-06-01-preview' = {
  name: 'srch-gbx2-${sfx}'
  location: location
  tags: tags
  sku: { name: 'basic' }
  identity: { type: 'SystemAssigned' }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'default'
    disableLocalAuth: true
    publicNetworkAccess: 'enabled'
    semanticSearch: 'disabled'
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-gbx2-${sfx}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-gbx2-${sfx}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output cosmosName string = cosmos.name
output storageName string = storage.name
output searchName string = search.name
output appInsightsName string = appInsights.name
output logAnalyticsName string = logAnalytics.name
