// The GeoCatalog (see infra/bicep/geo.bicep). Basic is the only tier, and it can't be changed after creation. The catalog has
// no managed identity, because it copies only from sources that carry their own access tokens, as the open Planetary
// Computer's do (Microsoft Learn, add-stac-item-to-collection).
param location string
param tags object
param sfx string

@description('Principal ID of the app relay identity, which may only read.')
param readerPrincipalId string

// Built-in role "GeoCatalog Reader", read from the subscription with `az role definition list` on 4 Nov 2026.
var geoCatalogReader = 'b7b8f583-43d0-40ae-b147-6b46f53661c1'

resource catalog 'Microsoft.Orbital/geoCatalogs@2026-04-15' = {
  name: 'geo-gbx-${sfx}'
  location: location
  tags: tags
  properties: { tier: 'Basic' }
}

resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: catalog
  name: guid(catalog.id, readerPrincipalId, geoCatalogReader)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', geoCatalogReader)
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

var uri = catalog.properties.catalogUri
output name string = catalog.name
// The data-plane address, without the trailing slash that Learn's samples say to remove.
output catalogUri string = endsWith(uri, '/') ? substring(uri, 0, max(length(uri) - 1, 0)) : uri
