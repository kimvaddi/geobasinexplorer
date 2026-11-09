// The Purview account (see infra/bicep/governance.bicep). The managed Event Hubs namespace is off: GeoBasin pushes lineage
// through the REST APIs and needs no Kafka notifications, so it would only add cost.
param location string
param tags object
param sfx string

resource account 'Microsoft.Purview/accounts@2024-04-01-preview' = {
  name: 'pview-gbx-${sfx}'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  sku: { name: 'Standard', capacity: 1 }
  properties: {
    publicNetworkAccess: 'Enabled'
    managedEventHubState: 'Disabled'
  }
}

output name string = account.name
output principalId string = account.identity.principalId
output endpoint string = 'https://${account.name}.purview.azure.com'
