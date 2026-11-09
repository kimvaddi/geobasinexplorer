// Guardrail policies at resource-group scope (subscription scope would also hit the MCAPS governance resources in westus2).
targetScope = 'resourceGroup'
param location string
param isAi bool = false
param isData bool = false

func builtIn(id string) string => tenantResourceId('Microsoft.Authorization/policyDefinitions', id)

resource allowedLocations 'Microsoft.Authorization/policyAssignments@2024-04-01' = {
  name: 'gbx-allowed-locations'
  properties: {
    displayName: 'GeoBasin: resources only in ${location} or global'
    policyDefinitionId: builtIn('e56962a6-4747-49cd-b67b-bf8b01975c4c')
    parameters: {
      listOfAllowedLocations: { value: [ location, 'global' ] }
      effect: { value: 'Deny' }
    }
  }
}

resource aiKeysOff 'Microsoft.Authorization/policyAssignments@2024-04-01' = if (isAi) {
  name: 'gbx-ai-local-auth-off'
  properties: {
    displayName: 'GeoBasin: Azure AI services must have key access disabled'
    policyDefinitionId: builtIn('71ef260a-8f18-47b7-abcb-62d0673d94dc')
    parameters: { effect: { value: 'Deny' } }
  }
}

resource storageSharedKey 'Microsoft.Authorization/policyAssignments@2024-04-01' = if (isData) {
  name: 'gbx-storage-shared-key'
  properties: {
    displayName: 'GeoBasin: storage accounts should prevent shared key access'
    policyDefinitionId: builtIn('8c6a50c6-9ffd-4ae7-986f-5fa6111f9a54')
    parameters: { effect: { value: 'Audit' } }
  }
}

resource kvPurge 'Microsoft.Authorization/policyAssignments@2024-04-01' = if (isData) {
  name: 'gbx-kv-deletion-protection'
  properties: {
    displayName: 'GeoBasin: key vaults should have deletion protection enabled'
    policyDefinitionId: builtIn('0b60c0b2-2dc2-4e1c-b5c9-abbed971de53')
    parameters: { effect: { value: 'Audit' } }
  }
}
