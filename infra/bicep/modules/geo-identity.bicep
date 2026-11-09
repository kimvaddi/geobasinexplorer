// The app relay's identity for the GeoCatalog (see infra/bicep/geo.bicep), kept beside the app's other identities. It gets
// GeoCatalog Reader on that catalog only.
param location string
param tags object

resource id 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gbx-geo'
  location: location
  tags: tags
}

output id string = id.id
output clientId string = id.properties.clientId
output principalId string = id.properties.principalId
