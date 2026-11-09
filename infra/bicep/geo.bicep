// Microsoft Planetary Computer Pro for GeoBasin: the GeoCatalog behind the cloud map's
// Planetary Computer overlays, public Copernicus imagery and elevation over the Cooper Basin (DATA_SOURCES.md).
// GeoCatalogs aren't offered in West US 3, so the catalog lives in its own resource group in North Central US, the
// nearest region that offers them, with that group's own location policy, as Azure Maps does in West US 2 and Purview in
// West US. The catalog accepts only Microsoft Entra tokens. The app's relay
// (services/api/src/planetary.ts) reads it with its own identity, id-gbx-geo, which holds GeoCatalog Reader on this
// catalog and nothing else. The operator, as subscription Owner, is already a GeoCatalog Administrator (Microsoft Learn,
// manage-access), so no other role is assigned. The data are loaded afterwards with infra/scripts/planetary_load.py.
//   az provider register -n Microsoft.Orbital --wait
//   az deployment sub what-if --location northcentralus -f infra/bicep/geo.bicep
//   az deployment sub create  --location northcentralus -n gbx-geo -f infra/bicep/geo.bicep
targetScope = 'subscription'

param location string = 'northcentralus'
@description('Region of rg-geobasin-app, where the relay identity sits beside the app\'s other identities.')
param appLocation string = 'westus3'
param sfx string
param tags object = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: 'platform-team'
  costCenter: 'unassigned'
  dataClassification: 'public'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-geo'
  location: location
  tags: union(tags, { layer: 'geo' })
}

module identity 'modules/geo-identity.bicep' = {
  scope: resourceGroup('rg-geobasin-app')
  name: 'gbx-geo-identity'
  params: { location: appLocation, tags: union(tags, { layer: 'app' }) }
}

module catalog 'modules/geocatalog.bicep' = {
  scope: rg
  name: 'gbx-geocatalog'
  params: { location: location, tags: union(tags, { layer: 'geo' }), sfx: sfx, readerPrincipalId: identity.outputs.principalId }
}

module policy 'modules/policy.bicep' = {
  scope: rg
  name: 'gbx-policy-rg-geobasin-geo'
  params: { location: location }
}

output catalogName string = catalog.outputs.name
output catalogUri string = catalog.outputs.catalogUri
output identityId string = identity.outputs.id
output identityClientId string = identity.outputs.clientId
