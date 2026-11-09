// GeoBasin Explorer AI version 2: the Microsoft Fabric capacity that holds the knowledge workspace (lakehouse, ontology,
// graph model and the Data Factory pipeline the ingestion framework publishes). Greenfield deployments create it here;
// brownfield deployments that already own a capacity skip this template and name theirs in infra/config/environment.env
// (GBX_FABRIC_CAPACITY_CREATE=false). F8 runs the framework and Fabric IQ comfortably for a pilot; F2 and F4 work for
// smaller loads with longer runs. Microsoft Learn: Microsoft.Fabric capacities (template reference) and Buy a Microsoft
// Fabric subscription.
//   infra/scripts/deploy.sh fabric
targetScope = 'subscription'

@description('Region of the capacity. Keep it with the version 2 Foundry resources where Fabric is offered.')
param location string = 'westus3'

@description('Resource group for the capacity.')
param resourceGroupName string = 'rg-geobasin-fabric'

@description('Capacity name: 3 to 63 lower-case letters and digits, starting with a letter.')
@minLength(3)
@maxLength(63)
param capacityName string

@description('Fabric SKU, for example F2, F4, F8 or F64.')
param skuName string = 'F8'

@description('Capacity administrators: user principal names for Entra users, object IDs for service principals.')
@minLength(1)
param adminMembers array

@description('Value of the owner tag.')
param ownerTag string = 'platform-team'

var tags = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: ownerTag
  costCenter: 'unassigned'
  dataClassification: 'public'
  layer: 'fabric'
  version: '2'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module capacity 'modules/fabric-capacity-resource.bicep' = {
  name: 'gbx2-fabric-capacity-resource'
  scope: rg
  params: {
    location: location
    capacityName: capacityName
    skuName: skuName
    adminMembers: adminMembers
    tags: tags
  }
}

output resourceGroup string = rg.name
output capacityName string = capacity.outputs.capacityName
output capacityId string = capacity.outputs.capacityId
