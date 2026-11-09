// The version 2 Foundry account, its three model deployments and the project geobasin-v2 with its connections to the
// agent data resources. Keys are disabled, so every call uses Microsoft Entra ID. The deployments are created one after
// another, and the project after them, because concurrent changes to one account conflict.
param location string
param sfx string
param tags object
param projectName string
param cosmosName string
param storageName string
param searchName string
param appInsightsName string
param routerCapacity int
param validatorCapacity int
param embedCapacity int
param routerModels array
@description('Fabric IQ\'s MCP endpoint for the knowledge ontology geobasin_knowledge; empty leaves the connection out.')
param fabricIqEndpoint string = ''

var accountName = 'aif-gbx2-${sfx}'

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = { name: cosmosName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageName }
resource search 'Microsoft.Search/searchServices@2024-06-01-preview' existing = { name: searchName }
resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = { name: appInsightsName }

resource account 'Microsoft.CognitiveServices/accounts@2025-10-01-preview' = {
  name: accountName
  location: location
  tags: tags
  sku: { name: 'S0' }
  kind: 'AIServices'
  identity: { type: 'SystemAssigned' }
  properties: {
    allowProjectManagement: true
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    networkAcls: { defaultAction: 'Allow', virtualNetworkRules: [], ipRules: [] }
    disableLocalAuth: true
  }
}

// The scientists' model (Microsoft Learn, Use model router: deploy with a routing mode and a model subset).
resource router 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = {
  parent: account
  name: 'gbx2-router'
  sku: { name: 'DataZoneStandard', capacity: routerCapacity }
  properties: {
    model: { format: 'OpenAI', name: 'model-router', version: '2025-11-18' }
    routing: { mode: 'balanced', models: routerModels }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

// The validator, never routed, as version 1's gbx-validator.
resource validator 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = {
  parent: account
  name: 'gbx2-validator'
  sku: { name: 'DataZoneStandard', capacity: validatorCapacity }
  properties: {
    model: { format: 'xAI', name: 'grok-4-1-fast-reasoning', version: '1' }
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  dependsOn: [ router ]
}

resource embed 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = {
  parent: account
  name: 'gbx2-embed'
  sku: { name: 'DataZoneStandard', capacity: embedCapacity }
  properties: {
    model: { format: 'OpenAI', name: 'text-embedding-3-large', version: '1' }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  dependsOn: [ validator ]
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-10-01-preview' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'GeoBasin version 2'
    description: 'Scientist agents for GeoBasin Explorer AI version 2, in the standard agent setup (docs/FOUNDRY_AGENTS.md).'
  }
  dependsOn: [ embed ]

  // Connections for the capability host. Agent Service accepts only Microsoft Entra ID for them, and needs the
  // resource ID in the metadata to resolve each resource (Microsoft Learn, Capability hosts).
  resource cosmosConnection 'connections@2025-10-01-preview' = {
    name: cosmosName
    properties: {
      category: 'CosmosDB'
      target: cosmos.properties.documentEndpoint
      authType: 'AAD'
      metadata: { ApiType: 'Azure', ResourceId: cosmos.id, location: cosmos.location }
    }
  }

  resource storageConnection 'connections@2025-10-01-preview' = {
    name: storageName
    properties: {
      category: 'AzureStorageAccount'
      target: storage.properties.primaryEndpoints.blob
      authType: 'AAD'
      metadata: { ApiType: 'Azure', ResourceId: storage.id, location: storage.location }
    }
  }

  resource searchConnection 'connections@2025-10-01-preview' = {
    name: searchName
    properties: {
      category: 'CognitiveSearch'
      target: 'https://${searchName}.search.windows.net'
      authType: 'AAD'
      metadata: { ApiType: 'Azure', ResourceId: search.id, location: search.location }
    }
  }

  // The scientists ask the ontology through Fabric IQ with the signed-in person's own token, which this
  // connection passes on with the ontology's delegated Power BI scopes (Microsoft Learn, Configure user delegation for
  // tools, supported scopes). The toolbox gbx-knowledge that holds it is made by services/scientists/deploy_hosted.py.
  resource fabricIqConnection 'connections@2025-10-01-preview' = if (!empty(fabricIqEndpoint)) {
    name: 'fabriciq-geobasin-knowledge'
    properties: {
      category: 'RemoteTool'
      target: fabricIqEndpoint
      #disable-next-line BCP036
      authType: 'UserEntraToken'
      isSharedToAll: false
      metadata: { description: 'Fabric IQ ontology geobasin_knowledge, asked as the signed-in person' }
      #disable-next-line BCP037
      audience: 'https://analysis.windows.net/powerbi/api'
      #disable-next-line BCP037
      scopes: [ 'https://analysis.windows.net/powerbi/api/Item.Execute.All', 'https://analysis.windows.net/powerbi/api/Item.Read.All' ]
    }
  }
}

// Hosted agents export OpenTelemetry traces through this account connection, as in the official sample.
resource appInsightsConnection 'Microsoft.CognitiveServices/accounts/connections@2025-10-01-preview' = {
  parent: account
  name: '${accountName}-appinsights'
  properties: {
    category: 'AppInsights'
    target: appInsights.id
    authType: 'ApiKey'
    isSharedToAll: true
    credentials: { key: appInsights.properties.ConnectionString }
    metadata: { ApiType: 'Azure', ResourceId: appInsights.id }
  }
  dependsOn: [ project ]
}

output accountName string = account.name
output accountEndpoint string = 'https://${accountName}.services.ai.azure.com'
output projectEndpoint string = 'https://${accountName}.services.ai.azure.com/api/projects/${projectName}'
output projectPrincipalId string = project.identity.principalId
#disable-next-line BCP053
output projectInternalId string = project.properties.internalId
output routerDeployment string = router.name
output validatorDeployment string = validator.name
output embedDeployment string = embed.name
output cosmosConnection string = project::cosmosConnection.name
output storageConnection string = project::storageConnection.name
output searchConnection string = project::searchConnection.name
