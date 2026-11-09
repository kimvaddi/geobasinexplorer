// Queue-chain scanner and separate six-hour signature updater; no API/worker switch is made here.
// https://learn.microsoft.com/azure/templates/microsoft.app/2025-07-01/jobs
// https://learn.microsoft.com/azure/container-apps/jobs
targetScope = 'resourceGroup'

param location string = resourceGroup().location
@description('Suffix of the foundation\'s resource names (main.bicep output suffix).')
param sfx string
param environmentName string = 'cae-gbx-${sfx}'
param registryName string = 'acrgbx${sfx}'
param storageAccountName string = 'stgbx${sfx}'
param dataResourceGroupName string = 'rg-geobasin-data'
param webIdentityName string = 'id-gbx-web'

@description('Tag of the separately built gbx-scanner image, shared by scanner and signature updater.')
@minLength(1)
param imageTag string

param tags object = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: 'platform-team'
  costCenter: 'unassigned'
  dataClassification: 'public'
  layer: 'app'
}

resource env 'Microsoft.App/managedEnvironments@2025-07-01' existing = { name: environmentName }
resource acr 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = { name: registryName }
resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: webIdentityName }
resource scanIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gbx-scan'
  location: location
  tags: tags
}
resource sigsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gbx-sigs'
  location: location
  tags: tags
}

var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
resource scanPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, scanIdentity.id, acrPull)
  properties: { roleDefinitionId: acrPull, principalId: scanIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource sigsPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, sigsIdentity.id, acrPull)
  properties: { roleDefinitionId: acrPull, principalId: sigsIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

module storageAccess 'modules/scanner-storage.bicep' = {
  name: 'gbx-scanner-data-access'
  scope: resourceGroup(dataResourceGroupName)
  params: {
    storageAccountName: storageAccountName
    scanPrincipalId: scanIdentity.properties.principalId
    sigsPrincipalId: sigsIdentity.properties.principalId
    webPrincipalId: webIdentity.properties.principalId
  }
}

resource scanner 'Microsoft.App/jobs@2025-07-01' = {
  name: 'gbx-scan'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${scanIdentity.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 900
      replicaRetryLimit: 0
      registries: [ { server: acr.properties.loginServer, identity: scanIdentity.id } ]
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 1
          pollingInterval: 30
          rules: [
            {
              name: 'scan-queue'
              type: 'azure-queue'
              metadata: { accountName: storageAccountName, queueName: 'scan-jobs', queueLength: '1', queueLengthStrategy: 'visibleonly' }
              identity: scanIdentity.id
            }
          ]
        }
      }
    }
    template: {
      containers: [
        {
          name: 'scanner'
          image: '${acr.properties.loginServer}/gbx-scanner:${imageTag}'
          command: [ 'python3', '/app/scan.py' ]
          resources: { cpu: 2, memory: '4Gi' }
          env: [
            { name: 'AZURE_CLIENT_ID', value: scanIdentity.properties.clientId }
            { name: 'STORAGE_ACCOUNT', value: storageAccountName }
            { name: 'GBX_NEXT_QUEUE', value: 'ingest-jobs' }
            { name: 'GBX_ROUTES', value: 'ingest-jobs,process-jobs' }
          ]
        }
      ]
    }
  }
  dependsOn: [ scanPull, storageAccess ]
}

resource signatures 'Microsoft.App/jobs@2025-07-01' = {
  name: 'gbx-sigs'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${sigsIdentity.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 900
      replicaRetryLimit: 0
      registries: [ { server: acr.properties.loginServer, identity: sigsIdentity.id } ]
      scheduleTriggerConfig: { cronExpression: '0 */6 * * *', parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [
        {
          name: 'signatures'
          image: '${acr.properties.loginServer}/gbx-scanner:${imageTag}'
          command: [ 'python3', '/app/scan.py' ]
          args: [ '--update-signatures' ]
          resources: { cpu: 2, memory: '4Gi' }
          env: [
            { name: 'AZURE_CLIENT_ID', value: sigsIdentity.properties.clientId }
            { name: 'STORAGE_ACCOUNT', value: storageAccountName }
          ]
        }
      ]
    }
  }
  dependsOn: [ sigsPull, storageAccess ]
}

output scanJobName string = scanner.name
output sigsJobName string = signatures.name
output scanIdentityId string = scanIdentity.id
output sigsIdentityId string = sigsIdentity.id
output scanIdentityClientId string = scanIdentity.properties.clientId
output sigsIdentityClientId string = sigsIdentity.properties.clientId
