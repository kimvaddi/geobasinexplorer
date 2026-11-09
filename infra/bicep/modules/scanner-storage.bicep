// RG-scoped role definition, container/queue-scoped assignments; no account keys or broad data grants.
// The separate ingest worker role is defined once in roles-data.bicep.
// https://learn.microsoft.com/azure/role-based-access-control/role-definitions#assignablescopes
// https://learn.microsoft.com/azure/storage/queues/authorize-access-azure-active-directory
targetScope = 'resourceGroup'

param storageAccountName string
param scanPrincipalId string
param sigsPrincipalId string
param webPrincipalId string

var roles = {
  blobReader: '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
  blobContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  queueReader: '19e7f393-937e-4f77-808e-94535e297925'
  queueProcessor: '8a0f0c08-91a1-4084-bc3d-661d67233fed'
  queueSender: 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
}
func rd(id string) string => subscriptionResourceId('Microsoft.Authorization/roleDefinitions', id)

resource storage 'Microsoft.Storage/storageAccounts@2025-06-01' existing = { name: storageAccountName }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' existing = { parent: storage, name: 'default' }
resource quarantine 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' existing = { parent: blobs, name: 'quarantine' }
resource signatures 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobs
  name: 'signatures'
  properties: { publicAccess: 'None' }
}
resource queues 'Microsoft.Storage/storageAccounts/queueServices@2025-06-01' existing = { parent: storage, name: 'default' }
resource scanQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' = { parent: queues, name: 'scan-jobs' }
resource ingestQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' existing = { parent: queues, name: 'ingest-jobs' }
resource processQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' = { parent: queues, name: 'process-jobs' }

resource scannerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, storageAccountName, 'gbx-quarantine-scanner-role-v1')
  properties: {
    roleName: 'GeoBasin quarantine scanner (${storageAccountName})'
    description: 'Read quarantined blob bytes/properties and read/write scan tags; no blob writes or deletes.'
    type: 'CustomRole'
    assignableScopes: [ resourceGroup().id ]
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write'
        ]
        notDataActions: []
      }
    ]
  }
}
resource scannerAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: quarantine
  name: guid(quarantine.id, scanPrincipalId, scannerRole.id)
  properties: { roleDefinitionId: scannerRole.id, principalId: scanPrincipalId, principalType: 'ServicePrincipal' }
}
resource scanSignatures 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: signatures
  name: guid(signatures.id, scanPrincipalId, roles.blobReader)
  properties: { roleDefinitionId: rd(roles.blobReader), principalId: scanPrincipalId, principalType: 'ServicePrincipal' }
}
resource updateSignatures 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: signatures
  name: guid(signatures.id, sigsPrincipalId, roles.blobContributor)
  properties: { roleDefinitionId: rd(roles.blobContributor), principalId: sigsPrincipalId, principalType: 'ServicePrincipal' }
}
resource scanQueueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [ roles.queueReader, roles.queueProcessor ]: {
  scope: scanQueue
  name: guid(scanQueue.id, scanPrincipalId, role)
  properties: { roleDefinitionId: rd(role), principalId: scanPrincipalId, principalType: 'ServicePrincipal' }
}]
resource forwardToIngest 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: ingestQueue
  name: guid(ingestQueue.id, scanPrincipalId, roles.queueSender)
  properties: { roleDefinitionId: rd(roles.queueSender), principalId: scanPrincipalId, principalType: 'ServicePrincipal' }
}
// Transitional: the web sender grant on ingest-jobs remains until the API integration release.
resource webScanQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: scanQueue
  name: guid(scanQueue.id, webPrincipalId, roles.queueSender)
  properties: { roleDefinitionId: rd(roles.queueSender), principalId: webPrincipalId, principalType: 'ServicePrincipal' }
}

// Live-lane route; the scanner still forwards the original message after every final verdict.
resource forwardToProcess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: processQueue
  name: guid(processQueue.id, scanPrincipalId, roles.queueSender)
  properties: { roleDefinitionId: rd(roles.queueSender), principalId: scanPrincipalId, principalType: 'ServicePrincipal' }
}
