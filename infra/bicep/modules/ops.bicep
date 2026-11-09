// Operations: logs, application telemetry and the alert action group.
param location string
param tags object
param sfx string
param alertEmail string

@description('Daily ingestion cap in GB. When reached, ingestion pauses until the next day. 0.5 GB keeps Front Door and WAF logs for a busy day while bounding cost (about 35 USD a month at most).')
param dailyQuotaGb string = '0.5'

resource law 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: 'log-gbx-${sfx}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json(dailyQuotaGb) }
    features: { disableLocalAuth: false }
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-gbx-${sfx}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
    IngestionMode: 'LogAnalytics'
    DisableLocalAuth: false
  }
}

resource ag 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-gbx-alerts'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'gbxalerts'
    enabled: true
    emailReceivers: [ { name: 'owner', emailAddress: alertEmail, useCommonAlertSchema: true } ]
  }
}

// 5xx and 429 spikes from the web app, behind Front Door and its WAF (edge.bicep).
resource failures 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'gbx-http-error-spike'
  location: location
  tags: tags
  properties: {
    displayName: 'GeoBasin: HTTP 401/429/5xx spike'
    severity: 2
    enabled: true
    scopes: [ appi.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'requests | where toint(resultCode) == 401 or toint(resultCode) == 429 or toint(resultCode) >= 500'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 50
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [ ag.id ] }
  }
}

// The daily cap pauses ingestion until the workspace's reset hour, which would blind the alert above; say so.
resource overQuota 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'gbx-log-daily-cap-reached'
  location: location
  tags: tags
  properties: {
    displayName: 'GeoBasin: log daily cap reached (logging paused)'
    severity: 2
    enabled: true
    scopes: [ law.id ]
    evaluationFrequency: 'PT1H'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '_LogOperation | where Category == "Ingestion" | where Detail has "OverQuota"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [ ag.id ] }
  }
}

output logAnalyticsName string = law.name
output logAnalyticsId string = law.id
output appInsightsConnectionString string = appi.properties.ConnectionString
output actionGroupId string = ag.id
