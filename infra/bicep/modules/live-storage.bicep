// Container/table/queue-scoped grants. No shared keys, tag-write, blob-delete or account-wide pipeline grants.
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/storage
// https://learn.microsoft.com/azure/storage/blobs/storage-manage-find-blobs
// Raw overwrite prevention is enforced with If-None-Match * in code; a storage immutability policy is PLANNED.
targetScope = 'resourceGroup'
param storageAccountName string
param pipelinePrincipalId string
param webPrincipalId string
var roles = {
  blobReader: '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
  queueReader: '19e7f393-937e-4f77-808e-94535e297925'
  queueProcessor: '8a0f0c08-91a1-4084-bc3d-661d67233fed'
  queueSender: 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
  tableContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
}
func rd(id string) string => subscriptionResourceId('Microsoft.Authorization/roleDefinitions', id)
resource storage 'Microsoft.Storage/storageAccounts@2025-06-01' existing = { name: storageAccountName }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' existing = { parent: storage, name: 'default' }
resource quarantine 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' existing = { parent: blobs, name: 'quarantine' }
resource existingArtifacts 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' existing = [for name in ['raw', 'processed']: { parent: blobs, name: name }]
// pages and manifests are created here, so they must not also be declared as existing in this template
// (ARM rejects a resource defined twice in one template: "defined multiple times").
resource newContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = [for name in ['pages', 'manifests']: {
  parent: blobs
  name: name
  properties: { publicAccess: 'None' }
}]
resource queues 'Microsoft.Storage/storageAccounts/queueServices@2025-06-01' existing = { parent: storage, name: 'default' }
resource scanQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' existing = { parent: queues, name: 'scan-jobs' }
resource processQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' existing = { parent: queues, name: 'process-jobs' }
resource tables 'Microsoft.Storage/storageAccounts/tableServices@2025-06-01' existing = { parent: storage, name: 'default' }
resource liveTables 'Microsoft.Storage/storageAccounts/tableServices/tables@2025-06-01' = [for name in ['sourceregistry', 'sourcereviews', 'lineage', 'silverdocuments', 'silverpages', 'silverchunks', 'pipelinejobs', 'sourceversions']: { parent: tables, name: name }]
resource usage 'Microsoft.Storage/storageAccounts/tableServices/tables@2025-06-01' existing = { parent: tables, name: 'usage' }
resource quarantineRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, storageAccountName, 'gbx-live-quarantine-v1')
  properties: {
    roleName: 'GeoBasin live quarantine receiver (${storageAccountName})'
    description: 'Land source bytes and read scanner tags; cannot write scan tags or delete bytes.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: [], notActions: [], dataActions: [
      'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
      'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'
      'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/read'
    ], notDataActions: [] }]
  }
}
resource artifactRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, storageAccountName, 'gbx-live-artifacts-v1')
  properties: {
    roleName: 'GeoBasin live artifact writer (${storageAccountName})'
    description: 'Read and write pipeline artifacts; no delete or index-tag permissions.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: [], notActions: [], dataActions: [
      'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
      'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'
    ], notDataActions: [] }]
  }
}
resource landingAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: quarantine
  name: guid(quarantine.id, pipelinePrincipalId, quarantineRole.id)
  // Blob path is a Resource attribute, relative to the container, with no leading slash or URL encoding.
  // https://learn.microsoft.com/azure/storage/blobs/storage-auth-abac-attributes#blob-path
  // https://learn.microsoft.com/azure/storage/blobs/storage-auth-abac-examples#blob-container-names-or-paths
  // https://learn.microsoft.com/azure/role-based-access-control/conditions-format
  properties: {
    principalId: pipelinePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: quarantineRole.id
    conditionVersion: '2.0'
    condition: '''
      (
        !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'})
        OR
        @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringLike 'sources/*'
      )
      '''
  }
}
resource existingArtifactAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in ['raw', 'processed']: {
  scope: existingArtifacts[i]
  name: guid(existingArtifacts[i].id, pipelinePrincipalId, artifactRole.id)
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: artifactRole.id }
}]
resource newArtifactAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in ['pages', 'manifests']: {
  scope: newContainers[i]
  name: guid(newContainers[i].id, pipelinePrincipalId, artifactRole.id)
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: artifactRole.id }
}]
resource webReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for i in [0, 1]: {
  scope: newContainers[i]
  name: guid(newContainers[i].id, webPrincipalId, roles.blobReader)
  properties: { principalId: webPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: rd(roles.blobReader) }
}]
resource scanSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: scanQueue
  name: guid(scanQueue.id, pipelinePrincipalId, roles.queueSender)
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: rd(roles.queueSender) }
}
resource processors 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [roles.queueReader, roles.queueProcessor]: {
  scope: processQueue
  name: guid(processQueue.id, pipelinePrincipalId, role)
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: rd(role) }
}]
// With the live scan off landing and approval queue straight to processing. Harmless with it on: the
// processor then still refuses any file without a clean, hash-bound verdict.
resource processSenders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in [pipelinePrincipalId, webPrincipalId]: {
  scope: processQueue
  name: guid(processQueue.id, principalId, roles.queueSender)
  properties: { principalId: principalId, principalType: 'ServicePrincipal', roleDefinitionId: rd(roles.queueSender) }
}]
resource tableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in ['sourceregistry', 'sourcereviews', 'lineage', 'silverdocuments', 'silverpages', 'silverchunks', 'pipelinejobs', 'sourceversions']: {
  scope: liveTables[i]
  name: guid(liveTables[i].id, pipelinePrincipalId, roles.tableContributor)
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: rd(roles.tableContributor) }
}]
resource metering 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: usage
  name: guid(usage.id, pipelinePrincipalId, roles.tableContributor)
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: rd(roles.tableContributor) }
}
