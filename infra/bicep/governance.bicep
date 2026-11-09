// Microsoft Purview for GeoBasin: classification, lineage, steward review and publish
//. The tenant already has a free Purview in West US,
// and only an account in that same region can upgrade it to the enterprise version (ARM error 39002 on 2 Nov 2026);
// West US also offers Unified Catalog (Microsoft Learn: unified-catalog-regions), which West US 3 doesn't. So the
// account lives in its own resource group in West US, with that group's own location policy, as Azure Maps does in
// West US 2. Purview holds metadata only: names, schemas, classifications and lineage, never document text or data rows.
// The first Purview account created in a tenant becomes the tenant's enterprise (pay-as-you-go) account (Learn:
// data-governance-free-version-upgrade-to-enterprise); governed assets in Unified Catalog bill to this subscription.
//   az deployment sub what-if --location westus -f infra/bicep/governance.bicep
//   az deployment sub create  --location westus -n gbx-governance -f infra/bicep/governance.bicep
targetScope = 'subscription'

param location string = 'westus'
param sfx string
param tags object = { project: 'GeoBasin Explorer AI', env: 'prototype', owner: 'platform-team', layer: 'governance' }

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-governance'
  location: location
  tags: tags
}

module purview 'modules/purview.bicep' = {
  scope: rg
  name: 'gbx-purview'
  params: { location: location, tags: tags, sfx: sfx }
}

module policy 'modules/policy.bicep' = {
  scope: rg
  name: 'gbx-policy-rg-geobasin-governance'
  params: { location: location }
}

output purviewName string = purview.outputs.name
output purviewPrincipalId string = purview.outputs.principalId
output purviewEndpoint string = purview.outputs.endpoint
