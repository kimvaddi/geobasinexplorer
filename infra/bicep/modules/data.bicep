// Data: evidence storage (quarantine, raw, processed), job queue, review and audit tables, Key Vault,
// and Microsoft Defender for Storage malware scanning on upload.
param location string
param tags object
param sfx string

@description('Monthly cap on scanned gigabytes for malware scanning (cost guard).')
param malwareScanCapGb int = 5

@description('Fabric workspaces admitted by trusted workspace access, so their OneLake shortcuts can read the library while public network access stays disabled (docs/LIBRARY_ONELAKE.md).')
param fabricWorkspaceIds array = []

@description('Microsoft Defender for Storage writes a resource instance rule of its own for malware scanning; keep it so a redeployment does not drop it.')
param keepDefenderScannerRule bool = true

resource st 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: 'stgbx${sfx}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // MCAPS governance forces private-only access; access is through the private endpoints in vnet-gbx.
    publicNetworkAccess: 'Disabled'
    // Resource instance rules admit only named resources; Microsoft Learn requires the zero subscription id for a Fabric
    // workspace (Trusted workspace access, Resource instance rule via ARM template).
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      resourceAccessRules: concat(
        keepDefenderScannerRule ? [ { tenantId: tenant().tenantId, resourceId: subscriptionResourceId('Microsoft.Security/datascanners', 'StorageDataScanner') } ] : [],
        map(fabricWorkspaceIds, id => { tenantId: tenant().tenantId, resourceId: '/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/Fabric/providers/Microsoft.Fabric/workspaces/${id}' }))
    }
    allowCrossTenantReplication: false
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: st
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = [for c in [ 'quarantine', 'raw', 'processed' ]: {
  parent: blobs
  name: c
  properties: { publicAccess: 'None' }
}]

resource queues 'Microsoft.Storage/storageAccounts/queueServices@2025-06-01' = {
  parent: st
  name: 'default'
}
resource jobQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' = {
  parent: queues
  name: 'ingest-jobs'
}

resource tablesSvc 'Microsoft.Storage/storageAccounts/tableServices@2025-06-01' = {
  parent: st
  name: 'default'
}
resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2025-06-01' = [for t in [ 'reviews', 'feedback', 'ingestjobs', 'usage' ]: {
  parent: tablesSvc
  name: t
}]

resource defender 'Microsoft.Security/defenderForStorageSettings@2025-06-01' = {
  scope: st
  name: 'current'
  properties: {
    isEnabled: true
    overrideSubscriptionLevelSettings: true
    malwareScanning: {
      onUpload: { isEnabled: true, capGBPerMonth: malwareScanCapGb }
    }
    sensitiveDataDiscovery: { isEnabled: false }
  }
}

resource kv 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: 'kv-gbx-${sfx}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    // Private only. The app keeps its sign-in secret as a Container Apps secret; the vault is there for operator-managed secrets.
    publicNetworkAccess: 'Disabled'
  }
}

output storageAccountName string = st.name
output storageAccountId string = st.id
output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
