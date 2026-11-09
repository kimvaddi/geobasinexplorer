// Parameters for fabric-capacity.bicep, exported by infra/scripts/deploy.sh from infra/config/environment.env.
using 'fabric-capacity.bicep'

param location = readEnvironmentVariable('GBX_LOCATION', 'westus3')
param resourceGroupName = readEnvironmentVariable('GBX_FABRIC_CAPACITY_RESOURCE_GROUP', 'rg-geobasin-fabric')
param capacityName = readEnvironmentVariable('GBX_FABRIC_CAPACITY_NAME')
param skuName = readEnvironmentVariable('GBX_FABRIC_CAPACITY_SKU', 'F8')
param adminMembers = filter(split(readEnvironmentVariable('GBX_FABRIC_ADMINS'), ','), m => !empty(trim(m)))
param ownerTag = readEnvironmentVariable('GBX_OWNER_TAG', 'platform-team')
