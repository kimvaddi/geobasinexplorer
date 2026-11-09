// A network security perimeter around the agent data (docs/FOUNDRY_AGENTS.md). Microsoft's MCAPS governance assigns
// Secure Future Initiative policies at the tenant root ("MCAPSGov Deploy and Modify Policies", SFI-NS2.2.1) that switch
// public network access off on every Cosmos DB and Storage account unless it is secured by a perimeter. Foundry Agent
// Service reaches the standard setup's Cosmos DB and Storage over their public endpoints with the project's managed
// identity, so both accounts join this perimeter in Enforced mode, where only its rules decide inbound access
// (Microsoft Learn, Transition to a network security perimeter). The Foundry account joins too, so the perimeter's
// members trust each other's managed identities (Learn, Add Microsoft Foundry to a network security perimeter), but in
// Transition mode, where its own public network setting still governs who reaches it. Inbound rules also
// admit managed identities from this subscription and, while the setup is verified, the operator's address. Entra role
// assignments still decide what any caller may do. The perimeter's access logs go to the Log Analytics workspace.
// Cosmos DB's support for perimeters is in public preview.
param location string
param sfx string
param tags object
param accountName string
param cosmosName string
param storageName string
param logAnalyticsName string
@description('Public address ranges, in CIDR form, from which the operator reads the agent data to verify the setup. Leave empty in normal running.')
param operatorAddressPrefixes array

resource account 'Microsoft.CognitiveServices/accounts@2025-10-01-preview' existing = { name: accountName }
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = { name: cosmosName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageName }
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = { name: logAnalyticsName }

resource perimeter 'Microsoft.Network/networkSecurityPerimeters@2025-05-01' = {
  name: 'nsp-gbx2-${sfx}'
  location: location
  tags: tags
  properties: {}
}

resource profile 'Microsoft.Network/networkSecurityPerimeters/profiles@2025-05-01' = {
  parent: perimeter
  name: 'agent-data'
  properties: {}
}

resource agentIdentities 'Microsoft.Network/networkSecurityPerimeters/profiles/accessRules@2025-05-01' = {
  parent: profile
  name: 'subscription-managed-identities'
  properties: {
    direction: 'Inbound'
    subscriptions: [ { id: subscription().id } ]
  }
}

resource operator 'Microsoft.Network/networkSecurityPerimeters/profiles/accessRules@2025-05-01' = if (!empty(operatorAddressPrefixes)) {
  parent: profile
  name: 'operator-verification'
  properties: {
    direction: 'Inbound'
    addressPrefixes: operatorAddressPrefixes
  }
}

resource cosmosAssociation 'Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2025-05-01' = {
  parent: perimeter
  name: 'agent-conversations'
  properties: {
    privateLinkResource: { id: cosmos.id }
    profile: { id: profile.id }
    accessMode: 'Enforced'
  }
  dependsOn: [ agentIdentities, operator ]
}

resource storageAssociation 'Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2025-05-01' = {
  parent: perimeter
  name: 'agent-files'
  properties: {
    privateLinkResource: { id: storage.id }
    profile: { id: profile.id }
    accessMode: 'Enforced'
  }
  dependsOn: [ cosmosAssociation ]
}

// Learning is the API's name for Transition mode.
resource foundryAssociation 'Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2025-05-01' = {
  parent: perimeter
  name: 'foundry-account'
  properties: {
    privateLinkResource: { id: account.id }
    profile: { id: profile.id }
    accessMode: 'Learning'
  }
  dependsOn: [ storageAssociation ]
}

resource accessLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: perimeter
  name: 'nsp-access-logs'
  properties: {
    workspaceId: logAnalytics.id
    logs: [ { categoryGroup: 'allLogs', enabled: true } ]
  }
}

output perimeterName string = perimeter.name
