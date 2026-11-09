// GeoBasin Explorer AI version 2: resumes the Fabric capacity every morning when something paused it overnight. Fabric
// content, and with it the knowledge ontology and Fabric IQ, is unavailable while its capacity is paused (Microsoft Learn,
// Pause and resume your Fabric capacity), and many organisations pause capacities at night to save cost. A Consumption
// Logic App reads the capacity each morning with its own managed identity and, only when it finds it paused, resumes it
// through the documented REST API and waits until it is active. That identity holds a custom role with nothing but read
// and resume on this one capacity, as Learn recommends, so it can neither pause, resize nor delete it, and a failed run
// alerts through the action group you name. Optional: deploy it only when your capacity is paused on a schedule. Deploy
// after infra/bicep/agents/foundry.bicep, which creates the resource group:
//   infra/scripts/deploy.sh fabric-resume
// Then run the job once and see what it did with: python3 infra/scripts/fabric_capacity.py job
targetScope = 'subscription'

@description('Region of the morning job, beside the capacity and the rest of version 2.')
param location string = 'westus3'

@description('Resource group that holds the job. infra/bicep/agents/foundry.bicep creates it.')
param resourceGroupName string = 'rg-geobasin-v2-ai'

@description('Resource group of the shared Fabric capacity.')
param capacityResourceGroupName string

@description('Name of the shared Fabric capacity that holds the GeoBasin workspace.')
param capacityName string

@description('Windows time zone of the schedule. Central Standard Time follows daylight saving time.')
param timeZone string = 'Central Standard Time'

@description('Hour of the morning run, in the schedule time zone.')
@minValue(0)
@maxValue(23)
param resumeHour int = 6

@description('Minute of the morning run.')
@minValue(0)
@maxValue(59)
param resumeMinute int = 0

@description('Earliest start of the schedule, yyyy-MM-ddTHH:mm:ss in the schedule time zone and without an offset, because the trigger applies the time zone only to a start time given that way.')
param startTime string = '2026-11-08T00:00:00'

@description('Set to false to keep the job but stop its morning runs, for example when the live phase ends.')
param enabled bool = true

@description('Action group told about failed runs (the foundation\'s actionGroupId output).')
param alertActionGroupId string

param tags object = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: 'platform-team'
  costCenter: 'unassigned'
  dataClassification: 'public'
  version: '2'
}

var layerTags = union(tags, { layer: 'v2-fabric' })
var capacityId = resourceId(subscription().subscriptionId, capacityResourceGroupName, 'Microsoft.Fabric/capacities', capacityName)

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' existing = {
  name: resourceGroupName
}

// Learn's prerequisites for pausing and resuming name the capacity actions and advise a custom role over the privileged
// built-in roles, which grant far more. The job only ever reads and resumes, so that is all this role allows.
resource resumer 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'geobasin-fabric-capacity-resumer')
  properties: {
    roleName: 'GeoBasin Fabric Capacity Resumer'
    description: 'Reads a Microsoft Fabric capacity and resumes it, and nothing else: it cannot pause, resize or delete it. Used by the GeoBasin version 2 morning job.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Fabric/capacities/read'
          'Microsoft.Fabric/capacities/resume/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      '${subscription().id}/resourceGroups/${capacityResourceGroupName}'
    ]
  }
}

module job 'modules/fabric-resume-job.bicep' = {
  scope: rg
  name: 'gbx2-fabric-resume-job'
  params: {
    location: location
    tags: layerTags
    name: 'logic-gbx2-fabric-resume'
    capacityId: capacityId
    timeZone: timeZone
    resumeHour: resumeHour
    resumeMinute: resumeMinute
    startTime: startTime
    enabled: enabled
    alertActionGroupId: alertActionGroupId
  }
}

module grant 'modules/fabric-resume-grant.bicep' = {
  scope: resourceGroup(capacityResourceGroupName)
  name: 'gbx2-fabric-resume-grant'
  params: {
    capacityName: capacityName
    principalId: job.outputs.principalId
    roleDefinitionId: resumer.id
  }
}

output capacityId string = capacityId
output workflowId string = job.outputs.workflowId
output triggerName string = job.outputs.triggerName
output principalId string = job.outputs.principalId
output roleDefinitionId string = resumer.id
