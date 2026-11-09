// The live ingestion lane's jobs (services/api/src/live/README.md) on the foundation's Container Apps environment and private
// storage endpoints: connect (fetch and verify a registered public source) and process (Document Intelligence OCR,
// extraction, indexing into Azure AI Search). Deployed by infra/scripts/deploy.sh platform.
// https://learn.microsoft.com/azure/container-apps/jobs
// https://learn.microsoft.com/azure/templates/microsoft.app/2025-07-01/jobs
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/containers#acrpull
targetScope = 'resourceGroup'
param location string = resourceGroup().location
@description('Suffix of the foundation\'s resource names (main.bicep output suffix).')
param sfx string
param environmentName string = 'cae-gbx-${sfx}'
param registryName string = 'acrgbx${sfx}'
param storageAccountName string = 'stgbx${sfx}'
param dataResourceGroupName string = 'rg-geobasin-data'
param aiResourceGroupName string = 'rg-geobasin-ai'
param foundryName string = 'aif-gbx-${sfx}'
param docIntelName string = 'di-gbx-${sfx}'
param searchName string = 'srch-gbx-${sfx}-basic'
param webIdentityName string = 'id-gbx-web'
@minLength(1)
param pipelineImageTag string
param appInsightsConnectionString string = ''
param purviewEndpoint string = 'https://pview-gbx-${sfx}.purview.azure.com'
@description('Internal name of the Purview collection where the pipeline identity holds Data Curator; needed only with purview = true.')
param purviewCollectionId string = ''
param aiEnabled bool = true
// The ClamAV gate and the Purview projection (docs/SECURITY.md). The gate is on by default; turning it off is a risk
// decision to record. The Purview projection needs governance.bicep.
@description('ClamAV verdict before the live lane reads a file. Off: landing queues straight to processing; the registered SHA-256 still binds every file.')
param liveScan bool = true
@description('Purview catalogue projection for each extraction and publication. Off: lineage stays in the app lineage table only.')
param purview bool = false
@description('Embedding tokens are booked against the app\'s token counter, so the jobs carry the app\'s daily token cap (keep it equal to GBX_TOKENS_PER_DAY). OCR pages stay capped.')
param tokensPerDay int = 50000000
@description('Daily Document Intelligence page cap for the jobs. Only an owner raises it, for a named landing, and the next deployment sets it back to 500.')
@minValue(1)
@maxValue(2000)
param ocrPagesPerDay int = 500
param tags object = { workload: 'geobasin-explorer-ai', environment: 'prototype', owner: 'platform-team', costCenter: 'unassigned', dataClassification: 'public', layer: 'pipeline' }
resource env 'Microsoft.App/managedEnvironments@2025-07-01' existing = { name: environmentName }
resource acr 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = { name: registryName }
resource web 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: webIdentityName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: 'id-gbx-pipeline', location: location, tags: tags }
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, identity.id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d') }
}
module storage 'modules/live-storage.bicep' = {
  name: 'gbx-live-data-access'
  scope: resourceGroup(dataResourceGroupName)
  params: { storageAccountName: storageAccountName, pipelinePrincipalId: identity.properties.principalId, webPrincipalId: web.properties.principalId }
}
module ai 'modules/live-ai.bicep' = {
  name: 'gbx-live-ai-access'
  scope: resourceGroup(aiResourceGroupName)
  params: { foundryName: foundryName, docIntelName: docIntelName, searchName: searchName, pipelinePrincipalId: identity.properties.principalId, webPrincipalId: web.properties.principalId }
}
var common = [
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'STORAGE_ACCOUNT', value: storageAccountName }
  { name: 'FOUNDRY_ENDPOINT', value: 'https://${foundryName}.services.ai.azure.com' }
  { name: 'DOCINTEL_ENDPOINT', value: 'https://${docIntelName}.cognitiveservices.azure.com' }
  { name: 'SEARCH_ENDPOINT', value: 'https://${searchName}.search.windows.net' }
  { name: 'PURVIEW_ENDPOINT', value: purviewEndpoint }
  { name: 'PURVIEW_COLLECTION_ID', value: purviewCollectionId }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'GBX_AI_ENABLED', value: aiEnabled ? 'true' : 'false' }
  { name: 'GBX_LIVE_SCAN', value: liveScan ? 'on' : 'off' }
  { name: 'GBX_PURVIEW', value: purview ? 'on' : 'off' }
  { name: 'GBX_CAP_OCR_PAGES', value: string(ocrPagesPerDay) }
  { name: 'GBX_CAP_OCR_PAGES_MONTH', value: '5000' }
  { name: 'GBX_CAP_TOKENS', value: string(tokensPerDay) }
  { name: 'GBX_CAP_TOKENS_MONTH', value: string(tokensPerDay * 30) }
]
resource connector 'Microsoft.App/jobs@2025-07-01' = {
  name: 'gbx-connect'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: { triggerType: 'Manual', replicaTimeout: 300, replicaRetryLimit: 0
      registries: [{ server: acr.properties.loginServer, identity: identity.id }], manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 } }
    template: { containers: [{ name: 'connector', image: '${acr.properties.loginServer}/gbx-pipeline:${pipelineImageTag}', command: ['node', 'dist/scripts/live-connect.mjs'], resources: { cpu: 1, memory: '2Gi' }, env: common }] }
  }
  dependsOn: [pull, storage, ai]
}
resource processor 'Microsoft.App/jobs@2025-07-01' = {
  name: 'gbx-process'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Event'
      // 420 * 60 s/page + 60 min DI + 60 min persistence is a 9 h conservative bound; app aborts at 10 h.
      // https://learn.microsoft.com/azure/container-apps/jobs#job-settings
      replicaTimeout: 39600
      replicaRetryLimit: 0
      registries: [{ server: acr.properties.loginServer, identity: identity.id }]
      eventTriggerConfig: { parallelism: 1, replicaCompletionCount: 1, scale: { minExecutions: 0, maxExecutions: 1, pollingInterval: 30
        rules: [{ name: 'process-queue', type: 'azure-queue', metadata: { accountName: storageAccountName, queueName: 'process-jobs', queueLength: '1', queueLengthStrategy: 'visibleonly' }, identity: identity.id }] } }
    }
    template: { containers: [{ name: 'processor', image: '${acr.properties.loginServer}/gbx-pipeline:${pipelineImageTag}', command: ['node', 'dist/scripts/live-process.mjs'], resources: { cpu: 2, memory: '4Gi' }, env: common }] }
  }
  dependsOn: [pull, storage, ai]
}
output pipelineIdentityPrincipalId string = identity.properties.principalId
output pipelineIdentityClientId string = identity.properties.clientId
output connectorJob string = connector.name
output processorJob string = processor.name
output purviewAssignmentRequired string = 'Lead must assign Data Curator on the intended Purview collection before processing/publishing. ARM Contributor is not a substitute.'
