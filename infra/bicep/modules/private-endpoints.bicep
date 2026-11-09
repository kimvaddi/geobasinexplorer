// Private endpoints for the storage account (blob, queue, table) in the GeoBasin private-endpoint subnet.
param location string
param tags object
param storageAccountName string
param peSubnetId string
param zoneIds object

resource st 'Microsoft.Storage/storageAccounts@2025-06-01' existing = { name: storageAccountName }

var services = [ 'blob', 'queue', 'table' ]
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = [for s in services: {
  name: 'pe-${storageAccountName}-${s}'
  location: location
  tags: tags
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [ { name: 'plsc-${s}', properties: { privateLinkServiceId: st.id, groupIds: [ s ] } } ]
  }
}]
resource zoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (s, i) in services: {
  parent: pe[i]
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: s, properties: { privateDnsZoneId: zoneIds[s] } } ] }
}]
