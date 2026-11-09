// GeoBasin Explorer AI version 2: the Foundry account for the scientist agents (docs/FOUNDRY_AGENTS.md).
// It is a new account in the standard agent setup, so conversations, agent definitions, files and vector stores live in
// your own Cosmos DB, Storage and AI Search rather than in Microsoft-managed storage. The template is adapted from
// the official Foundry sample 41-standard-agent-setup (github.com/microsoft-foundry/foundry-samples, MIT licence), the
// template Microsoft Learn names for keeping agent data in your own resources without network isolation (Networking
// options for Foundry Agent Service). It keeps public networking with Microsoft Entra ID on every call and keys
// disabled on every resource; Cosmos DB and Storage sit behind a network security perimeter, so they need no public
// access (modules/foundry-perimeter.bicep). It may live in the foundation's subscription or in a second one with free
// Data Zone quota for the models it deploys (GBX_AGENTS_SUBSCRIPTION_ID in infra/config/environment.env).
//   infra/scripts/deploy.sh agents      # runs what-if first when GBX_WHATIF=1
// or by hand:
//   az deployment sub create --subscription <subscription> -l <region> -n gbx2-foundry -f infra/bicep/agents/foundry.bicep -p infra/bicep/agents/foundry.bicepparam
// Then prove it works with: python3 infra/scripts/foundry_smoke.py
// While verifying from a workstation, GBX_OPERATOR_CIDRS admits that address to the agent data; a later deployment
// without it removes the rule (see modules/foundry-perimeter.bicep).
targetScope = 'subscription'

@description('Region for every version 2 Foundry resource. Choose one that offers hosted agents and the model router on Data Zone Standard; ideally the Fabric capacity\'s region too.')
param location string = 'westus3'

@description('Object ID of the operator, who gets Foundry User on the account and read access to the agent data so the setup can be verified.')
param operatorObjectId string

@description('Email that receives budget alerts. When empty, the alerts go to the subscription owners.')
param alertEmail string = ''

@description('Monthly budget for the version 2 Foundry resource group, in USD.')
param budgetAmount int = 300

@description('First day of the budget period, yyyy-MM-01.')
param budgetStartDate string

@description('Tokens-per-minute capacity, in thousands, of the model router deployment that every scientist uses. One squad run reads about 100,000 tokens in its first minute, and Azure checks the rate over 1- and 10-second windows, so at 150 a single run drew 429s on 8 November 2026; 300 is all of the Data Zone quota for the model router in West US 3 in this subscription.')
param routerCapacity int = 300

@description('Tokens-per-minute capacity, in thousands, of the Grok 4.1 Fast validator deployment.')
param validatorCapacity int = 150

@description('Tokens-per-minute capacity, in thousands, of the embedding deployment.')
param embedCapacity int = 100

@description('Comma-separated public address ranges, in CIDR form, admitted to the agent data while the operator verifies the setup. Leave empty in normal running, and delete the perimeter rule operator-verification afterwards.')
param operatorAddressPrefixes string = ''

@description('Fabric IQ\'s MCP endpoint for the knowledge ontology, which the scientists ask as the signed-in person: https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/<workspace id>/items/<ontology id>/ontologyEndpoint. Empty until the ontology exists (infra/scripts/deploy.sh knowledge sets it).')
param fabricIqEndpoint string = ''

// The routing subset is the compliance gate (Microsoft Learn, How model router works: best practices). Only OpenAI models
// are listed. xAI is left out so that the Grok validator never checks text written by its own model family, Anthropic
// would need separate deployments in this account first, and the other providers aren't approved for this work.
@description('Models the model router may choose from: at least two, and never an xAI model.')
param routerModels array = [
  { format: 'OpenAI', name: 'gpt-6-astra', version: '2026-09-03' }
  { format: 'OpenAI', name: 'gpt-5.6-sol', version: '2026-07-09' }
  { format: 'OpenAI', name: 'gpt-5.6-terra', version: '2026-07-09' }
  { format: 'OpenAI', name: 'gpt-5.4-mini', version: '2026-03-17' }
]

param tags object = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: 'platform-team'
  costCenter: 'unassigned'
  dataClassification: 'public'
  version: '2'
}

var sfx = take(uniqueString(subscription().id, 'geobasin-v2'), 6)
var projectName = 'geobasin-v2'
var layerTags = union(tags, { layer: 'v2-agents' })

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-geobasin-v2-ai'
  location: location
  tags: layerTags
}

module data 'modules/foundry-data.bicep' = {
  scope: rg
  name: 'gbx2-data'
  params: { location: location, sfx: sfx, tags: layerTags }
}

// The tenant's Secure Future Initiative policies switch off public access on Cosmos DB and Storage unless a network
// security perimeter secures them, so both join one, with the Foundry account, before Agent Service uses them
// (modules/foundry-perimeter.bicep).
module perimeter 'modules/foundry-perimeter.bicep' = {
  scope: rg
  name: 'gbx2-perimeter'
  params: {
    location: location
    sfx: sfx
    tags: layerTags
    accountName: account.outputs.accountName
    cosmosName: data.outputs.cosmosName
    storageName: data.outputs.storageName
    logAnalyticsName: data.outputs.logAnalyticsName
    operatorAddressPrefixes: filter(map(split(operatorAddressPrefixes, ','), p => trim(p)), p => !empty(p))
  }
}

module account 'modules/foundry-account.bicep' = {
  scope: rg
  name: 'gbx2-account'
  params: {
    location: location
    sfx: sfx
    tags: layerTags
    projectName: projectName
    cosmosName: data.outputs.cosmosName
    storageName: data.outputs.storageName
    searchName: data.outputs.searchName
    appInsightsName: data.outputs.appInsightsName
    routerCapacity: routerCapacity
    validatorCapacity: validatorCapacity
    embedCapacity: embedCapacity
    routerModels: routerModels
    fabricIqEndpoint: fabricIqEndpoint
  }
}

// Runtime roles for the project's managed identity, which the capability host provisioning also uses, and the
// operator's access. The Cosmos DB Operator role must exist before the capability host is created.
module access 'modules/foundry-access.bicep' = {
  scope: rg
  name: 'gbx2-access'
  params: {
    accountName: account.outputs.accountName
    projectPrincipalId: account.outputs.projectPrincipalId
    operatorObjectId: operatorObjectId
    cosmosName: data.outputs.cosmosName
    storageName: data.outputs.storageName
    searchName: data.outputs.searchName
    appInsightsName: data.outputs.appInsightsName
  }
}

module capabilityHosts 'modules/foundry-capability-hosts.bicep' = {
  scope: rg
  name: 'gbx2-capability-hosts'
  params: {
    accountName: account.outputs.accountName
    projectName: projectName
    cosmosConnection: account.outputs.cosmosConnection
    storageConnection: account.outputs.storageConnection
    searchConnection: account.outputs.searchConnection
  }
  dependsOn: [ access ]
}

// Roles on the containers and the database that the capability host has just created.
module agentDataAccess 'modules/foundry-agent-data-access.bicep' = {
  scope: rg
  name: 'gbx2-agent-data-access'
  params: {
    projectPrincipalId: account.outputs.projectPrincipalId
    projectInternalId: account.outputs.projectInternalId
    cosmosName: data.outputs.cosmosName
    storageName: data.outputs.storageName
  }
  dependsOn: [ capabilityHosts ]
}

module budget 'modules/foundry-budget.bicep' = {
  scope: rg
  name: 'gbx2-budget'
  params: { amount: budgetAmount, startDate: budgetStartDate, alertEmail: alertEmail }
}

output resourceGroup string = rg.name
output accountName string = account.outputs.accountName
output accountEndpoint string = account.outputs.accountEndpoint
output projectName string = projectName
output projectEndpoint string = account.outputs.projectEndpoint
output routerDeployment string = account.outputs.routerDeployment
output validatorDeployment string = account.outputs.validatorDeployment
output embedDeployment string = account.outputs.embedDeployment
output cosmosName string = data.outputs.cosmosName
output storageName string = data.outputs.storageName
output searchName string = data.outputs.searchName
output appInsightsName string = data.outputs.appInsightsName
output perimeterName string = perimeter.outputs.perimeterName
