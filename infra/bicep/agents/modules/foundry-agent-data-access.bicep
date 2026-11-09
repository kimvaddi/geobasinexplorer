// Roles for the version 2 project's managed identity on the agent data the capability host has created (Microsoft Learn,
// Set up standard agent resources): Storage Blob Data Owner limited by condition to the project's own *-azureml-agent
// containers, as in the official sample, and Cosmos DB Built-in Data Contributor on the database enterprise_memory.
param projectPrincipalId string
@description('The project\'s internal ID, 32 hexadecimal characters without dashes.')
param projectInternalId string
param cosmosName string
param storageName string

var workspaceId = '${substring(projectInternalId, 0, 8)}-${substring(projectInternalId, 8, 4)}-${substring(projectInternalId, 12, 4)}-${substring(projectInternalId, 16, 4)}-${substring(projectInternalId, 20, 12)}'
var blobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var condition = '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/read\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/filter/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringStartsWithIgnoreCase \'${workspaceId}\' AND @Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringLikeIgnoreCase \'*-azureml-agent\'))'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageName }
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = { name: cosmosName }

resource agentContainers 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, projectPrincipalId, blobDataOwner, workspaceId)
  properties: {
    principalId: projectPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataOwner)
    conditionVersion: '2.0'
    condition: condition
  }
}

resource agentDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, projectPrincipalId, workspaceId, 'enterprise_memory')
  properties: {
    principalId: projectPrincipalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: '${cosmos.id}/dbs/enterprise_memory'
  }
}
