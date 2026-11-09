// GeoBasin Explorer AI version 2 web app (docs/ARCHITECTURE.md): gbx-site in the foundation's Container Apps environment,
// on its own address (Front Door, edge.bicep), with its own single-tenant sign-in registration (infra/scripts/site-signin.sh)
// and a pinned image built from this repository with a brand pack (app/src/brand). It uses the platform's models, search
// indexes, storage, spatial service, Azure Maps and optional Esri relay, and keeps its own counts, reviews and feedback.
// It runs version 2's tool server for the scientists' hosted agents (GBX_TOOL_SERVER=on), which serves only the
// identities in toolCallers and only calls carrying a run ticket signed with runTicketKey; its Co-Scientist calls the
// hosted agent gbx-coscientist (GBX_V2_SCIENTISTS=on) and its copilot calls gbx-copilot (GBX_V2_COPILOT=on), with an
// identity of its own, id-gbx-site-agents, which deploy-site.sh grants access to those two agents alone
// (infra/scripts/grant-agent-caller.sh). Where a signed-in person's own token is at hand, kept for the API by the sign-in
// layer's token store, the API calls the agents on that person's behalf instead, so the scientists ask Fabric IQ with the
// person's own permissions (infra/scripts/grant-fabric-iq.sh). Deploy it with infra/scripts/deploy.sh site.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: 'platform-team'
  costCenter: 'unassigned'
  dataClassification: 'public'
  layer: 'site'
  version: '2'
}

@description('Foundation outputs (main.bicep), the same as apps.bicepparam.')
param environmentName string
param acrLoginServer string
param webIdentityId string
param webClientId string
param foundryEndpoint string
param docIntelEndpoint string
param searchEndpoint string
param storageAccountName string
param dataResourceGroup string = 'rg-geobasin-data'
param appInsightsConnectionString string
@description('Action group told about error spikes (foundation output actionGroupId).')
param actionGroupId string
param mapsAccountClientId string
param mapsIdentityId string
param mapsIdentityClientId string

@description('Live-lane settings (services/api/src/live/README.md): the version 1 Foundry project and the published serving agent that answer from the live sources, the source ids served live, and which questions go to them.')
param foundryProjectEndpoint string
param liveAgentName string
param liveAgentVersion string
param liveSources string
@allowed([ 'matched', 'all' ])
param liveRoute string = 'matched'

@description('Full image reference of a version 2 build, for example acrgbx<suffix>.azurecr.io/gbx-api:<version>-<stamp>-geobasin.')
param image string
param version string

@description('Public address of the app, https://<your host>; Front Door (edge.bicep) owns its domain and certificate.')
param publicUrl string

@description('Client ID of the app\'s own single-tenant sign-in registration (infra/scripts/site-signin.sh).')
param authClientId string

@description('Other client applications allowed to call the app with a bearer token: the Azure CLI for operator tests, and the scientists\' hosted agents once they exist.')
param allowedClientIds array = [ '04b07795-8ddb-461a-bbee-02f9e1bf7b46' ]

@secure()
@description('Client secret of that registration, created by deploy-site.sh and never written to disk.')
param authClientSecret string

@secure()
@description('Base64 key that signs run tickets (services/api/src/v2/run-ticket.ts), made afresh by every deploy-site.sh run. Tickets live at most fifteen minutes, so a new key only cuts short runs in flight.')
param runTicketKey string

@description('Comma-separated object IDs of the identities allowed to call the tool server: the scientists\' hosted agents. Empty refuses every caller.')
param toolCallers string = ''

@description('Version 2 Foundry project that hosts the scientists, and the agent the Co-Scientist calls. An empty endpoint leaves the Co-Scientist on the rules.')
param scientistsProjectEndpoint string = ''
param coscientistAgent string = 'gbx-coscientist'

@description('The agent that answers the copilot\'s questions for the live sources instead of version 1\'s agent; empty keeps version 1\'s.')
param copilotAgent string = 'gbx-copilot'

@description('The Fabric workspace and graph model behind the scientists\' knowledge tools (ingestion-framework/config/geobasin.json); empty leaves the tools unconnected.')
param fabricWorkspaceId string = ''
param fabricGraphModelId string = ''

@secure()
@description('ArcGIS Location Platform API key for the Esri base maps. infra/scripts/esri-key.sh stores it as the app\'s secret esri-api-key, and deploy-site.sh carries it into each deployment without printing it. Empty leaves the Esri base maps off.')
param esriApiKey string = ''

@description('Planetary Computer overlays (infra/bicep/geo.bicep outputs and infra/scripts/planetary_load.py). Empty leaves them off.')
param planetaryIdentityId string = ''
param planetaryIdentityClientId string = ''
param planetaryCatalogUri string = ''
param planetarySearches string = ''

@description('Kill switch for every model call.')
param aiEnabled bool = true

@description('Microsoft Defender for Storage malware scanning on upload. While it is off, uploads are refused, because nothing unscanned may be read or published.')
param malwareScanEnabled bool = true

@description('Daily question and token caps for the whole app (and each person\'s question cap), alongside the budget alerts and the kill switch.')
param questionsPerDay int = 5000
param tokensPerDay int = 50000000

resource env 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}

resource spatial 'Microsoft.App/containerApps@2025-07-01' existing = {
  name: 'gbx-spatial'
}

var planetary = !empty(planetaryIdentityId) && !empty(planetaryCatalogUri)

// Only this identity may call the scientists' agents; the platform jobs, which share id-gbx-web, never can.
resource agentsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-gbx-site-agents'
  location: location
  tags: tags
}

// Reads the Fabric knowledge graph for the knowledge tools, as a Viewer of its workspace (v2/grant-fabric-reader.sh).
resource fabricIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-gbx-site-fabric'
  location: location
  tags: tags
}

resource site 'Microsoft.App/containerApps@2025-07-01' = {
  name: 'gbx-site'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: union({ '${webIdentityId}': {}, '${mapsIdentityId}': {}, '${agentsIdentity.id}': {}, '${fabricIdentity.id}': {} }, planetary ? { '${planetaryIdentityId}': {} } : {}) }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [ { server: acrLoginServer, identity: webIdentityId } ]
      secrets: concat([
        { name: 'microsoft-provider-authentication-secret', value: authClientSecret }
        { name: 'run-ticket-key', value: runTicketKey }
      ], empty(esriApiKey) ? [] : [ { name: 'esri-api-key', value: esriApiKey } ])
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat([
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
            { name: 'AZURE_CLIENT_ID', value: webClientId }
            { name: 'GBX_OWNERS', value: '' }
            { name: 'GBX_REQUIRE_AUTH', value: 'true' }
            { name: 'GBX_SELF_URL', value: publicUrl }
            { name: 'GBX_CANONICAL_HOST', value: replace(publicUrl, 'https://', '') }
            { name: 'MAPS_ACCOUNT_CLIENT_ID', value: mapsAccountClientId }
            { name: 'MAPS_IDENTITY_CLIENT_ID', value: mapsIdentityClientId }
            { name: 'GBX_SPATIAL_URL', value: 'https://${spatial.properties.configuration.ingress.fqdn}' }
            { name: 'GBX_DATA_SCOPE', value: 'site' }
            { name: 'GBX_CAP_USER_QUESTIONS', value: string(questionsPerDay) }
            { name: 'GBX_CAP_QUESTIONS', value: string(questionsPerDay) }
            { name: 'GBX_CAP_QUESTIONS_MONTH', value: string(questionsPerDay * 30) }
            { name: 'GBX_CAP_TOKENS', value: string(tokensPerDay) }
            { name: 'GBX_CAP_TOKENS_MONTH', value: string(tokensPerDay * 30) }
            { name: 'GBX_TOOL_SERVER', value: 'on' }
            { name: 'GBX_TOOL_CALLERS', value: toolCallers }
            { name: 'GBX_RUN_TICKET_KEY', secretRef: 'run-ticket-key' }
            { name: 'GBX_V2_SCIENTISTS', value: empty(scientistsProjectEndpoint) ? 'off' : 'on' }
            { name: 'GBX_V2_PROJECT_ENDPOINT', value: scientistsProjectEndpoint }
            { name: 'GBX_V2_COSCIENTIST_AGENT', value: coscientistAgent }
            { name: 'GBX_V2_AGENTS_CLIENT_ID', value: agentsIdentity.properties.clientId }
            { name: 'GBX_V2_COPILOT', value: empty(scientistsProjectEndpoint) || empty(copilotAgent) ? 'off' : 'on' }
            { name: 'GBX_V2_COPILOT_AGENT', value: copilotAgent }
            { name: 'GBX_V2_FABRIC_WORKSPACE', value: fabricWorkspaceId }
            { name: 'GBX_V2_FABRIC_GRAPH', value: fabricGraphModelId }
            { name: 'GBX_V2_FABRIC_CLIENT_ID', value: fabricIdentity.properties.clientId }
            // The sign-in registration, which trusts the agents identity, exchanges a person's token for one
            // on their behalf (services/api/src/v2/obo.ts).
            { name: 'GBX_OBO_CLIENT_ID', value: authClientId }
            { name: 'GBX_OBO_TENANT_ID', value: tenant().tenantId }
          ], empty(esriApiKey) ? [] : [ { name: 'ESRI_API_KEY', secretRef: 'esri-api-key' } ], planetary ? [
            { name: 'PC_CATALOG_URI', value: planetaryCatalogUri }
            { name: 'PC_IDENTITY_CLIENT_ID', value: planetaryIdentityClientId }
            { name: 'PC_SEARCHES', value: planetarySearches }
          ] : [])
          probes: [
            { type: 'Startup', httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 5, failureThreshold: 24 }
            { type: 'Liveness', httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/api/health', port: 8080 }, periodSeconds: 15, failureThreshold: 3 }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
        rules: [ { name: 'http', http: { metadata: { concurrentRequests: '30' } } } ]
      }
    }
  }
}

// The sign-in layer keeps each person's tokens here, so the API gets the person's token for itself.
module tokenStore 'modules/site-token-store.bicep' = {
  scope: resourceGroup(dataResourceGroup)
  name: 'gbx-site-token-store'
  params: { storageAccountName: storageAccountName, containerName: 'site-auth-tokens', principalId: agentsIdentity.properties.principalId }
}

// Sign-in in front of every request, with the app's own registration.
// Sign-in also asks for a token for this API itself, which the token store keeps for the API to exchange.
resource auth 'Microsoft.App/containerApps/authConfigs@2026-07-01' = {
  parent: site
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: { unauthenticatedClientAction: 'AllowAnonymous' }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          clientSecretSettingName: 'microsoft-provider-authentication-secret'
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [ 'api://${authClientId}', authClientId ]
          defaultAuthorizationPolicy: { allowedApplications: concat([ authClientId ], allowedClientIds) }
        }
        login: { loginParameters: [ 'scope=openid profile email offline_access api://${authClientId}/user_impersonation' ] }
      }
    }
    login: {
      preserveUrlFragmentsForLogins: true
      tokenStore: { enabled: true, azureBlobStorage: { blobContainerUri: tokenStore.outputs.blobContainerUri, clientId: agentsIdentity.properties.clientId } }
    }
    httpSettings: { requireHttps: true, forwardProxy: { convention: 'Standard' } }
  }
}

// The app's own review, feedback and tool-run tables (data-scope.ts) in the platform storage account.
module tables 'modules/site-tables.bicep' = {
  scope: resourceGroup(dataResourceGroup)
  name: 'gbx-site-tables'
  params: { storageAccountName: storageAccountName, scope: 'site' }
}


resource errorSpike 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'gbx-site-error-spike'
  location: 'global'
  tags: tags
  properties: {
    description: 'GeoBasin web app: more than 50 answers with status 401, 429 or 5xx in 15 minutes.'
    severity: 2
    enabled: true
    scopes: [ site.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'errors'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          dimensions: [ { name: 'statusCode', operator: 'Include', values: [ '401', '429', '500', '502', '503', '504' ] } ]
          operator: 'GreaterThan'
          threshold: 50
          timeAggregation: 'Total'
        }
      ]
    }
    actions: [ { actionGroupId: actionGroupId } ]
  }
}

output siteFqdn string = site.properties.configuration.ingress.fqdn
output agentsPrincipalId string = agentsIdentity.properties.principalId
output agentsClientId string = agentsIdentity.properties.clientId
output fabricPrincipalId string = fabricIdentity.properties.principalId
output siteUrl string = publicUrl
