// Private network for GeoBasin (required by the tenant's MCAPS governance, which forces storage and Key Vault to
// private-only access; it is also the direction of the Private Link target).
// One virtual network: a subnet for the Container Apps environment and a subnet for private endpoints,
// plus the private DNS zones the endpoints register in.
param location string
param tags object

// The tenant's governance attaches a network security group to every subnet (named <vnet>-<subnet>-nsg-<region>,
// default rules only). They are declared here so a redeploy keeps them attached instead of detaching them.
resource nsgs 'Microsoft.Network/networkSecurityGroups@2024-05-01' = [for sn in [ 'snet-cae', 'snet-pe' ]: {
  name: 'vnet-gbx-${sn}-nsg-${location}'
  location: location
  tags: tags
  properties: { securityRules: [] }
}]

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-gbx'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [ '10.60.0.0/24' ] }
    subnets: [
      {
        name: 'snet-cae'
        properties: {
          addressPrefix: '10.60.0.0/25'
          networkSecurityGroup: { id: nsgs[0].id }
          delegations: [ { name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } } ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '10.60.0.128/27'
          networkSecurityGroup: { id: nsgs[1].id }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

var zones = [ 'privatelink.blob.${environment().suffixes.storage}', 'privatelink.queue.${environment().suffixes.storage}', 'privatelink.table.${environment().suffixes.storage}' ]
resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = [for z in zones: {
  name: z
  location: 'global'
  tags: tags
}]
resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (z, i) in zones: {
  parent: dns[i]
  name: 'link-vnet-gbx'
  location: 'global'
  tags: tags
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}]

output caeSubnetId string = vnet.properties.subnets[0].id
output peSubnetId string = vnet.properties.subnets[1].id
output blobZoneId string = dns[0].id
output queueZoneId string = dns[1].id
output tableZoneId string = dns[2].id
