// A site's own review, feedback and tool-run tables (services/api/src/data-scope.ts), named after its data scope, beside
// the main app's tables in the same storage account.
targetScope = 'resourceGroup'

param storageAccountName string

@description('The site\'s data scope (GBX_DATA_SCOPE), two to twelve lower-case letters.')
param scope string

resource st 'Microsoft.Storage/storageAccounts@2025-06-01' existing = {
  name: storageAccountName
}

resource tablesSvc 'Microsoft.Storage/storageAccounts/tableServices@2025-06-01' existing = {
  parent: st
  name: 'default'
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2025-06-01' = [for t in [ 'reviews', 'feedback', 'toolruns' ]: {
  parent: tablesSvc
  name: '${scope}${t}'
}]
