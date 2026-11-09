// The Fabric capacity itself (fabric-capacity.bicep deploys it into its own resource group).
targetScope = 'resourceGroup'

param location string
param capacityName string
param skuName string
param adminMembers array
param tags object

resource capacity 'Microsoft.Fabric/capacities@2023-11-01' = {
  name: capacityName
  location: location
  tags: tags
  sku: { name: skuName, tier: 'Fabric' }
  properties: { administration: { members: adminMembers } }
}

output capacityName string = capacity.name
output capacityId string = capacity.id
