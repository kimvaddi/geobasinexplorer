// Roles for the version 2 project's managed identity before its capability host exists, as the official sample assigns
// them (Microsoft Learn, Set up standard agent resources), and the operator's access. The project identity provisions
// the agent containers through the capability host and then uses them at run time.
param accountName string
param projectPrincipalId string
param operatorObjectId string
param cosmosName string
param storageName string
param searchName string
param appInsightsName string

var roles = {
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  cosmosDbOperator: '230815da-be43-4aae-9cb4-875f7bd000aa'
  searchIndexDataContributor: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  searchServiceContributor: '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
  logAnalyticsReader: '73c42c96-874c-492b-b04d-ab87d138a893'
  privilegedMonitoringDataReader: 'dbc9c667-e97f-4491-aee6-90b9cf960190'
  foundryUser: '53ca6127-db72-4b80-b1b0-d745d6d5456d'
}

resource account 'Microsoft.CognitiveServices/accounts@2025-10-01-preview' existing = { name: accountName }
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = { name: cosmosName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageName }
resource search 'Microsoft.Search/searchServices@2024-06-01-preview' existing = { name: searchName }
resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = { name: appInsightsName }

resource storageBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, projectPrincipalId, roles.storageBlobDataContributor)
  properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor) }
}

resource cosmosOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: cosmos
  name: guid(cosmos.id, projectPrincipalId, roles.cosmosDbOperator)
  properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cosmosDbOperator) }
}

resource searchIndexData 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: search
  name: guid(search.id, projectPrincipalId, roles.searchIndexDataContributor)
  properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.searchIndexDataContributor) }
}

resource searchService 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: search
  name: guid(search.id, projectPrincipalId, roles.searchServiceContributor)
  properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.searchServiceContributor) }
}

// Evaluation reads the agents' traces, including GenAI content, which needs both roles (official sample).
resource traces 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [ roles.logAnalyticsReader, roles.privilegedMonitoringDataReader ]: {
  scope: appInsights
  name: guid(appInsights.id, projectPrincipalId, role)
  properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role) }
}]

// The operator builds and tests agents and calls the models directly (Foundry User, formerly Azure AI User, at the
// account scope, which covers its projects; a project-scope assignment can't call the account's model endpoint), and
// reads the agent data in Cosmos DB to verify where conversations land (Cosmos DB Built-in Data Reader, a data-plane
// role).
resource operatorFoundry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, operatorObjectId, roles.foundryUser)
  properties: { principalId: operatorObjectId, principalType: 'User', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.foundryUser) }
}

resource operatorCosmosReader 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, operatorObjectId, 'cosmos-data-reader')
  properties: {
    principalId: operatorObjectId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000001'
    scope: cosmos.id
  }
}
