// A site's sign-in token store (Microsoft Learn, Enable an authentication token store in Azure Container Apps): a private
// blob container beside the site's tables, which only the site's own identity may read and write. With it, the sign-in
// layer hands the API each signed-in person's token for the API itself (X-MS-TOKEN-AAD-ACCESS-TOKEN), so the API can ask
// version 2's scientists on that person's behalf and Fabric IQ answers with their own permissions.
targetScope = 'resourceGroup'

param storageAccountName string
param containerName string

@description('Object ID of the identity the sign-in layer uses for the store.')
param principalId string

resource st 'Microsoft.Storage/storageAccounts@2025-06-01' existing = {
  name: storageAccountName
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' existing = {
  parent: st
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobs
  name: containerName
  properties: { publicAccess: 'None' }
}

// Storage Blob Data Contributor on this container alone.
var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
resource access 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(container.id, principalId, blobDataContributor)
  scope: container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output blobContainerUri string = '${st.properties.primaryEndpoints.blob}${containerName}'
