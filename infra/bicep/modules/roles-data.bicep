// Least-privilege data-plane roles on storage and Key Vault.
// Web identity: upload to quarantine, read raw and processed sources, enqueue jobs, review tables, read the Easy Auth secret.
// Ingestion identity: read and clear quarantine (including the malware-scan result tag), keep the original in raw, write processed, consume and re-send queue messages.
// Operator: one-time raw upload and bootstrap.
param storageAccountName string
param keyVaultName string
param webPrincipalId string
param ingestPrincipalId string
param operatorObjectId string

var roles = {
  blobContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  blobReader: '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
  queueSender: 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
  queueProcessor: '8a0f0c08-91a1-4084-bc3d-661d67233fed'
  queueReader: '19e7f393-937e-4f77-808e-94535e297925'
  tableContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  kvSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
}
func rd(id string) string => subscriptionResourceId('Microsoft.Authorization/roleDefinitions', id)

resource st 'Microsoft.Storage/storageAccounts@2025-06-01' existing = { name: storageAccountName }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' existing = { parent: st, name: 'default' }
resource quarantine 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' existing = { parent: blobs, name: 'quarantine' }
resource raw 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' existing = { parent: blobs, name: 'raw' }
resource processed 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' existing = { parent: blobs, name: 'processed' }
resource queues 'Microsoft.Storage/storageAccounts/queueServices@2025-06-01' existing = { parent: st, name: 'default' }
resource jobQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' existing = { parent: queues, name: 'ingest-jobs' }
resource kv 'Microsoft.KeyVault/vaults@2025-05-01' existing = { name: keyVaultName }

// Web identity
resource webQuarantine 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: quarantine
  name: guid(quarantine.id, webPrincipalId, roles.blobContributor)
  properties: { roleDefinitionId: rd(roles.blobContributor), principalId: webPrincipalId, principalType: 'ServicePrincipal' }
}
resource webRaw 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: raw
  name: guid(raw.id, webPrincipalId, roles.blobReader)
  properties: { roleDefinitionId: rd(roles.blobReader), principalId: webPrincipalId, principalType: 'ServicePrincipal' }
}
resource webProcessed 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: processed
  name: guid(processed.id, webPrincipalId, roles.blobReader)
  properties: { roleDefinitionId: rd(roles.blobReader), principalId: webPrincipalId, principalType: 'ServicePrincipal' }
}
resource webQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: jobQueue
  name: guid(jobQueue.id, webPrincipalId, roles.queueSender)
  properties: { roleDefinitionId: rd(roles.queueSender), principalId: webPrincipalId, principalType: 'ServicePrincipal' }
}
resource webTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, webPrincipalId, roles.tableContributor)
  properties: { roleDefinitionId: rd(roles.tableContributor), principalId: webPrincipalId, principalType: 'ServicePrincipal' }
}
resource webSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, webPrincipalId, roles.kvSecretsUser)
  properties: { roleDefinitionId: rd(roles.kvSecretsUser), principalId: webPrincipalId, principalType: 'ServicePrincipal' }
}

// Ingestion identity: can read a verdict and delete the copy, but cannot forge scan tags.
// Remove the previous Owner assignment after deployment (services/scanner/README.md).
// https://learn.microsoft.com/azure/role-based-access-control/role-definitions#assignablescopes
resource quarantineWorkerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, storageAccountName, 'gbx-quarantine-worker-role-v1')
  properties: {
    roleName: 'GeoBasin quarantine worker (${storageAccountName})'
    description: 'Read quarantined blob bytes and scan tags, then delete the quarantined copy; cannot write bytes or tags.'
    type: 'CustomRole'
    assignableScopes: [ resourceGroup().id ]
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/read'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete'
        ]
        notDataActions: []
      }
    ]
  }
}
resource ingestQuarantine 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: quarantine
  name: guid(quarantine.id, ingestPrincipalId, quarantineWorkerRole.id)
  properties: { roleDefinitionId: quarantineWorkerRole.id, principalId: ingestPrincipalId, principalType: 'ServicePrincipal' }
}
resource ingestRaw 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: raw
  name: guid(raw.id, ingestPrincipalId, roles.blobContributor)
  properties: { roleDefinitionId: rd(roles.blobContributor), principalId: ingestPrincipalId, principalType: 'ServicePrincipal' }
}
resource ingestProcessed 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: processed
  name: guid(processed.id, ingestPrincipalId, roles.blobContributor)
  properties: { roleDefinitionId: rd(roles.blobContributor), principalId: ingestPrincipalId, principalType: 'ServicePrincipal' }
}
resource ingestQueueProc 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: jobQueue
  name: guid(jobQueue.id, ingestPrincipalId, roles.queueProcessor)
  properties: { roleDefinitionId: rd(roles.queueProcessor), principalId: ingestPrincipalId, principalType: 'ServicePrincipal' }
}
resource ingestQueueRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: jobQueue
  name: guid(jobQueue.id, ingestPrincipalId, roles.queueReader)
  properties: { roleDefinitionId: rd(roles.queueReader), principalId: ingestPrincipalId, principalType: 'ServicePrincipal' }
}
// A retry or a hold (kill switch) re-sends the message with a delay; the processor role can't update messages.
resource ingestQueueSend 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: jobQueue
  name: guid(jobQueue.id, ingestPrincipalId, roles.queueSender)
  properties: { roleDefinitionId: rd(roles.queueSender), principalId: ingestPrincipalId, principalType: 'ServicePrincipal' }
}
resource ingestTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, ingestPrincipalId, roles.tableContributor)
  properties: { roleDefinitionId: rd(roles.tableContributor), principalId: ingestPrincipalId, principalType: 'ServicePrincipal' }
}

// Operator (bootstrap and data load)
resource opBlobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, operatorObjectId, roles.blobContributor)
  properties: { roleDefinitionId: rd(roles.blobContributor), principalId: operatorObjectId, principalType: 'User' }
}
resource opTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, operatorObjectId, roles.tableContributor)
  properties: { roleDefinitionId: rd(roles.tableContributor), principalId: operatorObjectId, principalType: 'User' }
}
