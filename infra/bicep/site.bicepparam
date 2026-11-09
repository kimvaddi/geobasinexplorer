// Parameters for site.bicep (the version 2 web app). infra/scripts/deploy-site.sh sets every value below in its own
// environment, from infra/config/environment.env, the foundation outputs and fresh secrets, so nothing secret is written
// to disk:
//   GBX_SITE_IMAGE              full image reference of a version 2 build (deploy.sh images)
//   GBX_SITE_AUTH_CLIENT_ID     client ID of the app's sign-in registration (site-signin.sh)
//   GBX_SITE_AUTH_CLIENT_SECRET client secret of that registration, made afresh by each deployment
//   GBX_SITE_RUN_TICKET_KEY     run-ticket key, made afresh by each deployment
//   GBX_SITE_TOOL_CALLERS       object IDs of the scientists' hosted agents (empty until they exist)
//   GBX_SITE_AGENT_CLIENT_IDS   their client IDs, comma-separated, admitted by the sign-in layer (empty until they exist)
//   GBX_ESRI_API_KEY            optional Esri key; GBX_PC_* optional Planetary Computer overlay settings
using 'site.bicep'

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
param mapsAccountClientId = readEnvironmentVariable('GBX_MAPS_ACCOUNT_CLIENT_ID')
param mapsIdentityId = readEnvironmentVariable('GBX_MAPS_IDENTITY_ID')
param mapsIdentityClientId = readEnvironmentVariable('GBX_MAPS_IDENTITY_CLIENT_ID')
param actionGroupId = readEnvironmentVariable('GBX_ACTION_GROUP_ID')

param image = readEnvironmentVariable('GBX_SITE_IMAGE')
param version = readEnvironmentVariable('GBX_VERSION')
param publicUrl = readEnvironmentVariable('GBX_SITE_URL')
param authClientId = readEnvironmentVariable('GBX_SITE_AUTH_CLIENT_ID')
param authClientSecret = readEnvironmentVariable('GBX_SITE_AUTH_CLIENT_SECRET')
param runTicketKey = readEnvironmentVariable('GBX_SITE_RUN_TICKET_KEY')
param toolCallers = readEnvironmentVariable('GBX_SITE_TOOL_CALLERS', '')
param allowedClientIds = concat([ '04b07795-8ddb-461a-bbee-02f9e1bf7b46' ], filter(split(readEnvironmentVariable('GBX_SITE_AGENT_CLIENT_IDS', ''), ','), id => !empty(trim(id))))

// Version 2: the scientists' Foundry project and the Fabric knowledge graph behind their typed tools.
param scientistsProjectEndpoint = readEnvironmentVariable('GBX_V2_PROJECT_ENDPOINT', '')
param fabricWorkspaceId = readEnvironmentVariable('GBX_FABRIC_WORKSPACE_ID', '')
param fabricGraphModelId = readEnvironmentVariable('GBX_FABRIC_GRAPH_MODEL_ID', '')

param esriApiKey = readEnvironmentVariable('GBX_ESRI_API_KEY', '')
param planetaryIdentityId = readEnvironmentVariable('GBX_PC_IDENTITY_ID', '')
param planetaryIdentityClientId = readEnvironmentVariable('GBX_PC_IDENTITY_CLIENT_ID', '')
param planetaryCatalogUri = readEnvironmentVariable('GBX_PC_CATALOG_URI', '')
param planetarySearches = readEnvironmentVariable('GBX_PC_SEARCHES', '')
