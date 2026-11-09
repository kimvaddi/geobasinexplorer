// AI: GeoBasin's own Foundry resource with build and runtime projects, pinned model deployments
// in the US data zone, Document Intelligence for OCR, and Azure AI Search (Basic, Entra roles only).
param location string
param tags object
param sfx string

@description('Tokens-per-minute capacity units (thousands) for each deployment. Spend is bounded by the app\'s usage caps (config.ts).')
// 100 is the Data Zone Standard gpt-6-astra quota ceiling in westus3; a live Q10 agent run needs well over 60K tokens a minute.
param answerCapacity int = 100
param validatorCapacity int = 100
// 300K TPM: the live pipeline embeds a 420-page report in batches of 32 passages; 50K TPM hit 429s (2 Nov 2026).
param embedCapacity int = 300

@description('Search tier. A Free service can\'t change tier and may be deleted when idle (Learn, search-sku-tier), so each tier gets its own service name.')
@allowed([ 'free', 'basic' ])
param searchSku string = 'basic'

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'aif-gbx-${sfx}'
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: 'aif-gbx-${sfx}'
    disableLocalAuth: true
    allowProjectManagement: true
    publicNetworkAccess: 'Enabled'
  }
}

resource projectRuntime 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundry
  name: 'geobasin-runtime'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'GeoBasin runtime'
    description: 'Runtime answering and validation for GeoBasin Explorer AI.'
  }
}

resource projectBuild 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundry
  name: 'geobasin-build'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'GeoBasin build-time agency'
    description: 'Build-time question generation and evaluation; never reads runtime holdouts.'
  }
  dependsOn: [ projectRuntime ]
}

// Deployments on one account are created one at a time.
resource answer 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: 'gbx-answer'
  sku: { name: 'DataZoneStandard', capacity: answerCapacity }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-6-astra', version: '2026-09-03' }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  dependsOn: [ projectBuild ]
}

// Grok 4.1 Fast (reasoning) replaced Grok 4.7, whose US DataZone deployment timed out on
// every validation prompt (8 of 8 at 60 s); Grok 4.1 Fast finished all 8 with a median of 6.5 s and a worst case of 18 s.
resource validator 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: 'gbx-validator'
  sku: { name: 'DataZoneStandard', capacity: validatorCapacity }
  properties: {
    model: { format: 'xAI', name: 'grok-4-1-fast-reasoning', version: '1' }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  dependsOn: [ answer ]
}

resource embed 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: 'gbx-embed'
  sku: { name: 'DataZoneStandard', capacity: embedCapacity }
  properties: {
    model: { format: 'OpenAI', name: 'text-embedding-3-large', version: '1' }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  dependsOn: [ validator ]
}

resource docIntel 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'di-gbx-${sfx}'
  location: location
  tags: tags
  kind: 'FormRecognizer'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: 'di-gbx-${sfx}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: searchSku == 'free' ? 'srch-gbx-${sfx}' : 'srch-gbx-${sfx}-${searchSku}'
  location: location
  tags: tags
  sku: { name: searchSku }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'Default'
    publicNetworkAccess: 'enabled'
    disableLocalAuth: true
  }
}

output foundryName string = foundry.name
output foundryEndpoint string = 'https://${foundry.properties.customSubDomainName}.services.ai.azure.com'
output docIntelName string = docIntel.name
output docIntelEndpoint string = docIntel.properties.endpoint
output searchName string = search.name
output searchEndpoint string = 'https://${search.name}.search.windows.net'
