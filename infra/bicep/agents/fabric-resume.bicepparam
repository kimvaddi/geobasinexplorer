// Parameters for fabric-resume.bicep, exported by infra/scripts/deploy.sh from infra/config/environment.env.
using 'fabric-resume.bicep'

param location = readEnvironmentVariable('GBX_LOCATION', 'westus3')
param capacityResourceGroupName = readEnvironmentVariable('GBX_FABRIC_CAPACITY_RESOURCE_GROUP')
param capacityName = readEnvironmentVariable('GBX_FABRIC_CAPACITY_NAME')
param timeZone = readEnvironmentVariable('GBX_FABRIC_RESUME_TIME_ZONE', 'UTC')
param resumeHour = int(readEnvironmentVariable('GBX_FABRIC_RESUME_HOUR', '6'))
param resumeMinute = 0
param enabled = true
param alertActionGroupId = readEnvironmentVariable('GBX_ACTION_GROUP_ID')
