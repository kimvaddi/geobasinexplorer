// The library in OneLake (docs/LIBRARY_ONELAKE.md): lets the Fabric workspace's identity read the library's clean files,
// extractions and publication manifests through OneLake shortcuts while the storage account stays closed to the internet.
//
// Trusted workspace access needs a resource instance rule for the workspace, which infra/bicep/modules/data.bicep declares
// through fabricWorkspaceIds, and a role for the identity that authorises the shortcut, here the workspace identity.
// Microsoft Learn accepts Storage Blob Delegator on the account together with data access granted lower down, so the
// identity can read only raw, processed and manifests: never quarantine, page images, tables or queues.
// infra/scripts/deploy.sh library deploys it with the values the deployment discovered.
targetScope = 'resourceGroup'

@description('Object id of the Fabric workspace identity (Workspaces - Get Workspace, workspaceIdentity.servicePrincipalId).')
param workspaceIdentityPrincipalId string

@description('The library storage account (the foundation output storageAccountName).')
param storageAccountName string

@description('Containers the shortcut may read.')
param containers array = [ 'raw', 'processed', 'manifests' ]

var blobDelegator = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
var blobDataReader = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

resource st 'Microsoft.Storage/storageAccounts@2025-06-01' existing = {
  name: storageAccountName
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' existing = {
  parent: st
  name: 'default'
}
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' existing = [for c in containers: {
  parent: blobs
  name: c
}]

resource delegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(st.id, workspaceIdentityPrincipalId, blobDelegator)
  scope: st
  properties: {
    principalId: workspaceIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDelegator)
    description: 'GeoBasin Fabric workspace identity: user delegation keys for the library shortcut'
  }
}

resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (c, i) in containers: {
  name: guid(container[i].id, workspaceIdentityPrincipalId, blobDataReader)
  scope: container[i]
  properties: {
    principalId: workspaceIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReader)
    description: 'GeoBasin Fabric workspace identity: read ${c} through the library shortcut'
  }
}]
