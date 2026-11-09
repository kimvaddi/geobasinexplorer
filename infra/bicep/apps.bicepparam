// Parameters for apps.bicep. Every value comes from the shell that runs the deployment: infra/scripts/deploy.sh exports
// them from infra/config/environment.env and the foundation outputs, so nothing environment-specific or secret is kept here.
using 'apps.bicep'

// Foundation outputs (main.bicep), exported by infra/scripts/deploy.sh from the gbx-foundation deployment.
param environmentName = readEnvironmentVariable('GBX_ENVIRONMENT_NAME')
param acrLoginServer = readEnvironmentVariable('GBX_ACR_LOGIN_SERVER')
param webIdentityId = readEnvironmentVariable('GBX_WEB_IDENTITY_ID')
param webClientId = readEnvironmentVariable('GBX_WEB_CLIENT_ID')
param foundryEndpoint = readEnvironmentVariable('GBX_FOUNDRY_ENDPOINT')
param docIntelEndpoint = readEnvironmentVariable('GBX_DOCINTEL_ENDPOINT')
param searchEndpoint = readEnvironmentVariable('GBX_SEARCH_ENDPOINT')
param storageAccountName = readEnvironmentVariable('GBX_STORAGE_ACCOUNT')
param appInsightsConnectionString = readEnvironmentVariable('GBX_APPI_CONNECTION_STRING')

// Live lane (services/api/src/live/README.md): the version 1 Foundry project, the published serving agent, the sources
// served live and the route. Empty agent settings keep the packaged answers until the lane is activated.
param foundryProjectEndpoint = readEnvironmentVariable('GBX_LIVE_PROJECT_ENDPOINT', '')
param liveAgentName = readEnvironmentVariable('GBX_LIVE_AGENT_NAME', '')
param liveAgentVersion = readEnvironmentVariable('GBX_LIVE_AGENT_VERSION', '')
param liveSources = readEnvironmentVariable('GBX_LIVE_SOURCES', '')
param liveRoute = readEnvironmentVariable('GBX_LIVE_ROUTE', 'matched')

param aiEnabled = bool(readEnvironmentVariable('GBX_AI_ENABLED', 'true'))
param malwareScanEnabled = bool(readEnvironmentVariable('GBX_MALWARE_SCAN', 'true'))
param questionsPerDay = int(readEnvironmentVariable('GBX_QUESTIONS_PER_DAY', '5000'))
param tokensPerDay = int(readEnvironmentVariable('GBX_TOKENS_PER_DAY', '50000000'))
param ingestIdentityId = readEnvironmentVariable('GBX_INGEST_IDENTITY_ID')
param ingestClientId = readEnvironmentVariable('GBX_INGEST_CLIENT_ID')
param liveScan = bool(readEnvironmentVariable('GBX_LIVE_SCAN', 'true'))

param image = readEnvironmentVariable('GBX_IMAGE')
param version = readEnvironmentVariable('GBX_VERSION')
param spatialImage = readEnvironmentVariable('GBX_SPATIAL_IMAGE')
param spatialIdentityId = readEnvironmentVariable('GBX_SPATIAL_IDENTITY_ID')
