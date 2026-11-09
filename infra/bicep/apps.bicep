// GeoBasin Explorer AI platform workloads: the GDAL/PROJ spatial service, the ingestion job and the evaluation job.
// Deployed after the foundation (main.bicep) and the container images exist (infra/scripts/deploy.sh platform):
//   az deployment group create -g rg-geobasin-app -n gbx-apps -f infra/bicep/apps.bicep -p infra/bicep/apps.bicepparam
// The web app itself, with its sign-in, is site.bicep.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: 'platform-team'
  costCenter: 'unassigned'
  dataClassification: 'public'
  layer: 'app'
}

@description('Foundation outputs (main.bicep).')
param environmentName string
param acrLoginServer string
param webIdentityId string
param webClientId string
param ingestIdentityId string
param ingestClientId string
param foundryEndpoint string
param docIntelEndpoint string
param searchEndpoint string

// Immutable pin of the live lane's serving agent. Leave blank until an approved version is published; serving fails closed.
@description('Verified Foundry project endpoint used by the live lane\'s serving agent.')
param foundryProjectEndpoint string = ''
param liveAgentName string = ''
param liveAgentVersion string = ''
@description('Comma-separated source commitments on this serving revision; empty preserves the packaged baseline until activation.')
param liveSources string = ''
@description('Which questions the prepared rules do not cover go to the live agent: matched (a live well or a migrated document among the best library matches) or all (every such question while a live publication exists).')
@allowed([ 'matched', 'all' ])
param liveRoute string = 'matched'

param storageAccountName string
param appInsightsConnectionString string

@description('Full image reference, for example acrgbx<suffix>.azurecr.io/gbx-api:<version>-<stamp>-geobasin.')
param image string
param version string

@description('Kill switch for every model call (answers fall back to the offline engine or "Not found").')
param aiEnabled bool = true

@description('Daily question and token caps. The evaluation and ingestion jobs get them too, because they book against the same counters as the web app; keep them equal to the site\'s. OCR, upload, evaluation-run, spatial and map-tile caps have their own defaults.')
param questionsPerDay int = 5000
param tokensPerDay int = 50000000

@description('Microsoft Defender for Storage malware scanning. While it is paused (infra/defender.sh), uploads are refused, because nothing unscanned may be read or published.')
param malwareScanEnabled bool = true

@description('ClamAV verdict before the live lane reads a file. Off: the owner API queues landings and approvals straight to processing.')
param liveScan bool = true

@description('GDAL/PROJ spatial service image and identity (image pull only).')
param spatialImage string
param spatialIdentityId string

resource env 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}

var common = [
  { name: 'FOUNDRY_ENDPOINT', value: foundryEndpoint }
  { name: 'DOCINTEL_ENDPOINT', value: docIntelEndpoint }
  { name: 'SEARCH_ENDPOINT', value: searchEndpoint }
  { name: 'FOUNDRY_PROJECT_ENDPOINT', value: foundryProjectEndpoint }
  { name: 'GBX_AGENT_NAME', value: liveAgentName }
  { name: 'GBX_AGENT_VERSION', value: liveAgentVersion }
  { name: 'GBX_LIVE_SOURCES', value: liveSources }
  { name: 'GBX_LIVE_ROUTE', value: liveRoute }
  { name: 'STORAGE_ACCOUNT', value: storageAccountName }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'GBX_VERSION', value: version }
  { name: 'GBX_AI_ENABLED', value: aiEnabled ? 'true' : 'false' }
  { name: 'GBX_MALWARE_SCAN', value: malwareScanEnabled ? 'on' : 'off' }
  { name: 'GBX_LIVE_SCAN', value: liveScan ? 'on' : 'off' }
  { name: 'GBX_CAP_USER_QUESTIONS', value: string(questionsPerDay) }
  { name: 'GBX_CAP_QUESTIONS', value: string(questionsPerDay) }
  { name: 'GBX_CAP_QUESTIONS_MONTH', value: string(questionsPerDay * 30) }
  { name: 'GBX_CAP_TOKENS', value: string(tokensPerDay) }
  { name: 'GBX_CAP_TOKENS_MONTH', value: string(tokensPerDay * 30) }
]

// GDAL/PROJ spatial service. Internal ingress: only apps in this environment can reach it, and the web API
// validates and rate-limits every request before forwarding it. It reads nothing but the data baked into its image.
resource spatial 'Microsoft.App/containerApps@2025-07-01' = {
  name: 'gbx-spatial'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${spatialIdentityId}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 8080, transport: 'http', allowInsecure: false }
      registries: [ { server: acrLoginServer, identity: spatialIdentityId } ]
    }
    template: {
      containers: [
        {
          name: 'spatial'
          image: spatialImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          probes: [
            { type: 'Startup', httpGet: { path: '/health', port: 8080 }, periodSeconds: 5, failureThreshold: 24 }
            { type: 'Liveness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 15, failureThreshold: 3 }
          ]
        }
      ]
      // One warm replica keeps sections and "What we know here" instant (about 20 ms of work each).
      scale: { minReplicas: 1, maxReplicas: 2, rules: [ { name: 'http', http: { metadata: { concurrentRequests: '40' } } } ] }
    }
  }
}

// Ingestion: one execution per queued upload. KEDA watches the queue with the ingestion identity (no keys).
// The replica timeout (30 min) is shorter than the message's hidden time (32 min, worker.ts) so nothing runs twice.
resource ingest 'Microsoft.App/jobs@2025-07-01' = {
  name: 'gbx-ingest'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${ingestIdentityId}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      registries: [ { server: acrLoginServer, identity: ingestIdentityId } ]
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 2
          pollingInterval: 30
          rules: [
            {
              name: 'ingest-queue'
              type: 'azure-queue'
              metadata: { accountName: storageAccountName, queueName: 'ingest-jobs', queueLength: '1', queueLengthStrategy: 'visibleonly' }
              identity: ingestIdentityId
            }
          ]
        }
      }
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          command: [ 'node', 'dist/worker.mjs' ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(common, [ { name: 'AZURE_CLIENT_ID', value: ingestClientId } ])
        }
      ]
    }
  }
}

// Evaluation: started by the operator inside Azure (storage is private), for example
//   az containerapp job start -g rg-geobasin-app -n gbx-eval --args benchmarks   (or: all)
// Results go to the environment's logs. Limited to a few runs a day by the service's own caps.
resource evalJob 'Microsoft.App/jobs@2025-07-01' = {
  name: 'gbx-eval'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${webIdentityId}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 3600
      replicaRetryLimit: 0
      registries: [ { server: acrLoginServer, identity: webIdentityId } ]
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [
        {
          name: 'eval'
          image: image
          command: [ 'node', 'dist/scripts/eval.mjs' ]
          args: [ 'benchmarks' ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(common, [ { name: 'AZURE_CLIENT_ID', value: webClientId } ])
        }
      ]
    }
  }
}

output environmentStaticIp string = env.properties.?staticIp ?? ''
output customDomainVerificationId string = env.properties.?customDomainConfiguration.?customDomainVerificationId ?? ''
output spatialFqdn string = spatial.properties.configuration.ingress.fqdn
