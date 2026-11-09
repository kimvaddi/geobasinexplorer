// GeoBasin Explorer AI edge (secured public domain): Azure Front Door Premium with a WAF in front of the Container Apps
// environment. Front Door reaches the app only over Private Link, and the environment's public network access is
// switched off, so the canonical host (www.<your zone> by default; the zone apex redirects to it) is the only way in.
// The DNS zone must already be an Azure DNS zone in rg-geobasin-edge, delegated from your registrar or parent zone.
//   az deployment group create -g rg-geobasin-edge -f infra/bicep/edge.bicep -p infra/bicep/edge.bicepparam
// First rollout (docs/DEPLOYMENT.md, "Edge"): deploy with cutover = false, wait for both domains to validate,
// approve the Private Link request on the environment, disable its public access, then redeploy with cutover = true.
targetScope = 'resourceGroup'

param sfx string
param tags object = {
  workload: 'geobasin-explorer-ai'
  environment: 'prototype'
  owner: 'platform-team'
  costCenter: 'unassigned'
  dataClassification: 'public'
  layer: 'edge'
}

@description('Azure DNS zone of the bought domain (same resource group).')
param zoneName string

@description('The one host users sign in on; the apex redirects here.')
param canonicalHost string = 'www.${zoneName}'

@description('Resource ID of the Container Apps environment, the Private Link target.')
param environmentId string

@description('Region of the environment, used for the Front Door Private Link endpoint.')
param privateLinkLocation string = 'westus3'

@description('FQDN of the web app on the environment default domain; Front Door sends it as the Host header.')
param originHostName string

@description('Point the site host and the apex at Front Door. Keep false until both domains are validated and the Private Link connection is approved.')
param cutover bool = false

@description('Log Analytics workspace for Front Door access and WAF logs.')
param logAnalyticsId string

@description('Requests per minute from one client address before the WAF blocks it for the rest of that minute.')
param requestsPerMinutePerIp int = 600

@description('Esri map tiles per minute from one client address. A screen of map is dozens of tiles and a busy minute of panning several hundred, so tiles have their own count and never use up the allowance for the rest of the app (services/api/src/esri.ts).')
param esriTilesPerMinutePerIp int = 3000


// The relay's tile path exactly, with or without the scheme and host and with no query string, so a query that merely
// mentions the path can't move other requests into the larger tile allowance.
var esriTilePath = '^(?:https?://[^/]+)?/api/basemap/esri/[a-z]+/[0-9]+/[0-9]+/[0-9]+$'

resource zone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: zoneName
}

// Prevention mode with the Microsoft Default Rule Set 2.2 (anomaly scoring, paranoia level 1) and bot protection.
resource waf 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2025-03-01' = {
  name: 'wafgbx${sfx}'
  location: 'Global'
  tags: tags
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: 'Prevention'
      requestBodyCheck: 'Enabled'
      customBlockResponseStatusCode: 403
    }
    customRules: {
      // Learn: rate limits can apply to different paths, and a breach blocks only the traffic that matches that rule
      // (azure/web-application-firewall/afds/waf-front-door-rate-limit).
      rules: [
        {
          name: 'RateLimitPerClient'
          priority: 100
          enabledState: 'Enabled'
          ruleType: 'RateLimitRule'
          rateLimitDurationInMinutes: 1
          rateLimitThreshold: requestsPerMinutePerIp
          matchConditions: [
            { matchVariable: 'RequestUri', operator: 'Contains', matchValue: [ '/' ] }
            { matchVariable: 'RequestUri', operator: 'RegEx', negateCondition: true, matchValue: [ esriTilePath ], transforms: [ 'Lowercase' ] }
          ]
          action: 'Block'
        }
        {
          name: 'RateLimitEsriTiles'
          priority: 110
          enabledState: 'Enabled'
          ruleType: 'RateLimitRule'
          rateLimitDurationInMinutes: 1
          rateLimitThreshold: esriTilesPerMinutePerIp
          matchConditions: [ { matchVariable: 'RequestUri', operator: 'RegEx', matchValue: [ esriTilePath ], transforms: [ 'Lowercase' ] } ]
          action: 'Block'
        }
      ]
    }
    managedRules: {
      managedRuleSets: [
        { ruleSetType: 'Microsoft_DefaultRuleSet', ruleSetVersion: '2.2', ruleSetAction: 'Block' }
        { ruleSetType: 'Microsoft_BotManagerRuleSet', ruleSetVersion: '1.1' }
      ]
    }
  }
}

// Answers can take close to a minute (writer plus validator), so the origin timeout is longer than the default 60 s.
resource afd 'Microsoft.Cdn/profiles@2025-04-15' = {
  name: 'afd-gbx-${sfx}'
  location: 'global'
  tags: tags
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: { originResponseTimeoutSeconds: 120 }
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2025-04-15' = {
  parent: afd
  name: 'gbx-${sfx}'
  location: 'global'
  tags: tags
  properties: { enabledState: 'Enabled', autoGeneratedDomainNameLabelScope: 'TenantReuse' }
}

// A single origin, so health probes stay off and Front Door always forwards to it.
resource originGroup 'Microsoft.Cdn/profiles/originGroups@2025-04-15' = {
  parent: afd
  name: 'og-web'
  properties: {
    loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 50 }
    sessionAffinityState: 'Disabled'
  }
}

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2025-04-15' = {
  parent: originGroup
  name: 'web'
  properties: {
    hostName: originHostName
    originHostHeader: originHostName
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
    sharedPrivateLinkResource: {
      privateLink: { id: environmentId }
      groupId: 'managedEnvironments'
      privateLinkLocation: privateLinkLocation
      requestMessage: 'GeoBasin Explorer AI Front Door'
    }
  }
}

// Front Door-managed certificates, validated with _dnsauth TXT records in the Azure DNS zone.
resource wwwDomain 'Microsoft.Cdn/profiles/customDomains@2025-04-15' = {
  parent: afd
  name: replace(canonicalHost, '.', '-')
  properties: {
    hostName: canonicalHost
    tlsSettings: { certificateType: 'ManagedCertificate', minimumTlsVersion: 'TLS12' }
    azureDnsZone: { id: zone.id }
  }
}

resource apexDomain 'Microsoft.Cdn/profiles/customDomains@2025-04-15' = {
  parent: afd
  name: replace(zoneName, '.', '-')
  properties: {
    hostName: zoneName
    tlsSettings: { certificateType: 'ManagedCertificate', minimumTlsVersion: 'TLS12' }
    azureDnsZone: { id: zone.id }
  }
}

resource wwwValidation 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: '_dnsauth.${split(canonicalHost, '.')[0]}'
  properties: { TTL: 3600, TXTRecords: [ { value: [ wwwDomain.properties.validationProperties.validationToken ] } ] }
}

// The apex has no CNAME, so its managed certificate needs this token refreshed at each renewal (Learn, apex-domain).
resource apexValidation 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: '_dnsauth'
  properties: { TTL: 3600, TXTRecords: [ { value: [ apexDomain.properties.validationProperties.validationToken ] } ] }
}

resource canonical 'Microsoft.Cdn/profiles/ruleSets@2025-04-15' = {
  parent: afd
  name: 'canonicalhost'
}

// Identity headers come only from the Container Apps sign-in layer, which runs after Front Door. Deleting any a client
// sends means they can't be forged even if sign-in were ever switched off (services/api/src/auth.ts).
var identityHeaders = [
  [ 'x-ms-client-principal', 'x-ms-client-principal-id', 'x-ms-client-principal-name', 'x-ms-client-principal-idp', 'x-ms-token-aad-id-token' ]
  [ 'x-ms-token-aad-access-token', 'x-ms-token-aad-refresh-token', 'x-ms-token-aad-expires-on' ]
]
@batchSize(1)
resource stripIdentity 'Microsoft.Cdn/profiles/ruleSets/rules@2025-04-15' = [for (headers, i) in identityHeaders: {
  parent: canonical
  name: 'stripIdentityHeaders${i + 1}'
  dependsOn: [ apexToWww ] // the redirect moves to order 3 first, so the order numbers never clash
  properties: {
    order: i + 1
    matchProcessingBehavior: 'Continue'
    conditions: [
      {
        name: 'RequestUri'
        parameters: { typeName: 'DeliveryRuleRequestUriConditionParameters', operator: 'Any', negateCondition: false, matchValues: [], transforms: [] }
      }
    ]
    actions: [for h in headers: {
      name: 'ModifyRequestHeader'
      parameters: { typeName: 'DeliveryRuleHeaderActionParameters', headerAction: 'Delete', headerName: h }
    }]
  }
}]

resource apexToWww 'Microsoft.Cdn/profiles/ruleSets/rules@2025-04-15' = {
  parent: canonical
  name: 'apexToWww'
  properties: {
    order: 3
    matchProcessingBehavior: 'Stop'
    conditions: [
      {
        name: 'HostName'
        parameters: {
          typeName: 'DeliveryRuleHostNameConditionParameters'
          operator: 'Equal'
          negateCondition: false
          matchValues: [ zoneName ]
          transforms: [ 'Lowercase' ]
        }
      }
    ]
    actions: [
      {
        name: 'UrlRedirect'
        parameters: {
          typeName: 'DeliveryRuleUrlRedirectActionParameters'
          redirectType: 'Moved'
          destinationProtocol: 'Https'
          customHostname: canonicalHost
        }
      }
    ]
  }
}

// No caching: every response is per user. The endpoint's own azurefd.net name isn't routed, so sign-in only
// ever sees the registered host.
resource route 'Microsoft.Cdn/profiles/afdEndpoints/routes@2025-04-15' = {
  parent: endpoint
  name: 'web'
  dependsOn: [ origin, apexToWww, stripIdentity ]
  properties: {
    customDomains: [ { id: wwwDomain.id }, { id: apexDomain.id } ]
    originGroup: { id: originGroup.id }
    ruleSets: [ { id: canonical.id } ]
    supportedProtocols: [ 'Http', 'Https' ]
    patternsToMatch: [ '/*' ]
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Disabled'
    httpsRedirect: 'Enabled'
    enabledState: 'Enabled'
  }
}

resource security 'Microsoft.Cdn/profiles/securityPolicies@2025-04-15' = {
  parent: afd
  name: 'waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: waf.id }
      associations: [ { domains: [ { id: wwwDomain.id }, { id: apexDomain.id } ], patternsToMatch: [ '/*' ] } ]
    }
  }
}

resource wwwRecord 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = if (cutover) {
  parent: zone
  name: split(canonicalHost, '.')[0]
  properties: { TTL: 300, CNAMERecord: { cname: endpoint.properties.hostName } }
}

// Alias record: Front Door's addresses can change, so the apex follows the endpoint instead of a fixed IP.
resource apexRecord 'Microsoft.Network/dnsZones/A@2018-05-01' = if (cutover) {
  parent: zone
  name: '@'
  properties: { TTL: 300, targetResource: { id: endpoint.id } }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: afd
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      { category: 'FrontDoorAccessLog', enabled: true }
      { category: 'FrontDoorWebApplicationFirewallLog', enabled: true }
    ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

output profileName string = afd.name
output frontDoorId string = afd.properties.frontDoorId
output endpointHostName string = endpoint.properties.hostName
output wwwDomainName string = wwwDomain.name
output apexDomainName string = apexDomain.name
