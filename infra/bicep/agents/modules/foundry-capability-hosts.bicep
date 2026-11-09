// Capability hosts tell Agent Service which resources hold a project's agent data (Microsoft Learn, Capability hosts).
// The account host enables Agent Service, and the project host names the three connections; nothing is inherited from
// the account, and a host can't be updated, only deleted and recreated.
param accountName string
param projectName string
param cosmosConnection string
param storageConnection string
param searchConnection string

resource account 'Microsoft.CognitiveServices/accounts@2025-10-01-preview' existing = { name: accountName }
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-10-01-preview' existing = {
  parent: account
  name: projectName
}

resource accountHost 'Microsoft.CognitiveServices/accounts/capabilityHosts@2025-10-01-preview' = {
  parent: account
  name: 'caphost-account'
  properties: { capabilityHostKind: 'Agents' }
}

resource projectHost 'Microsoft.CognitiveServices/accounts/projects/capabilityHosts@2025-10-01-preview' = {
  parent: project
  name: 'caphost-project'
  properties: {
    // The Bicep type omits this property, but the official sample and Learn's REST example both send it.
    #disable-next-line BCP037
    capabilityHostKind: 'Agents'
    threadStorageConnections: [ cosmosConnection ]
    storageConnections: [ storageConnection ]
    vectorStoreConnections: [ searchConnection ]
  }
  dependsOn: [ accountHost ]
}
