// Azure Maps for the map workspace (Azure Maps is the geospatial presentation service).
// Maps accounts aren't offered in West US 3, so this account lives in its own resource group in West US 2 (owner
// decision, 1 November 2026); the group's location policy allows only that region and global.
// Keys are disabled: the web API hands signed-in users a short-lived Microsoft Entra token obtained with a dedicated
// managed identity that holds only the render permission below (Learn: how-to-secure-spa-app, authentication).
param location string
param tags object
param sfx string

@description('Principals that may read map tiles: the map-token identity, and the operator for local testing.')
param readers array

@description('Browser origins allowed to call Azure Maps with this account.')
param allowedOrigins array

resource maps 'Microsoft.Maps/accounts@2023-06-01' = {
  name: 'maps-gbx-${sfx}'
  location: location
  tags: tags
  sku: { name: 'G2' }
  kind: 'Gen2'
  properties: {
    disableLocalAuth: true
    cors: { corsRules: [ { allowedOrigins: allowedOrigins } ] }
  }
}

// Least privilege (the built-in Azure Maps roles cover every Maps API): map rendering only.
resource renderReader 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'gbx-maps-render-reader')
  properties: {
    roleName: 'GeoBasin Maps Render Reader (${sfx})'
    description: 'Read Azure Maps render data (map tiles, styles, fonts and sprites) and nothing else.'
    type: 'CustomRole'
    permissions: [ { actions: [], notActions: [], dataActions: [ 'Microsoft.Maps/accounts/services/render/read' ], notDataActions: [] } ]
    assignableScopes: [ resourceGroup().id ]
  }
}

resource readerAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in readers: {
  scope: maps
  name: guid(maps.id, r.id, renderReader.id)
  properties: { roleDefinitionId: renderReader.id, principalId: r.id, principalType: r.type }
}]

output accountName string = maps.name
// The account's client ID goes with every Microsoft Entra-authenticated request (x-ms-client-id).
output accountClientId string = maps.properties.uniqueId
