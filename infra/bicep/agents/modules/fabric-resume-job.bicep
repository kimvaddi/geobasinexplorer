// The morning job: a Consumption Logic App that resumes the shared Fabric capacity when it finds it paused, and an alert
// that tells the owner when a run fails. Every call signs in with the workflow's system-assigned managed identity for
// Azure Resource Manager (Microsoft Learn, Authenticate with managed identities in Azure Logic Apps).
param location string
param tags object
param name string
@description('Resource ID of the Fabric capacity.')
param capacityId string
param timeZone string
param resumeHour int
param resumeMinute int
param startTime string
param enabled bool
param alertActionGroupId string

var arm = environment().resourceManager
var capacityUrl = '${arm}${substring(capacityId, 1)}'
var apiVersion = 'api-version=2023-11-01'
var identity = { type: 'ManagedServiceIdentity', audience: arm }
var triggerName = 'Every_morning'

resource workflow 'Microsoft.Logic/workflows@2019-05-01' = {
  name: name
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    state: enabled ? 'Enabled' : 'Disabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      triggers: {
        '${triggerName}': {
          type: 'Recurrence'
          recurrence: {
            frequency: 'Day'
            interval: 1
            startTime: startTime
            timeZone: timeZone
            schedule: { hours: [ resumeHour ], minutes: [ resumeMinute ] }
          }
        }
      }
      actions: {
        Read_capacity: {
          type: 'Http'
          inputs: { method: 'GET', uri: '${capacityUrl}?${apiVersion}', authentication: identity }
          runAfter: {}
        }
        // Resuming a capacity that is already active is refused with 400, so the job resumes only a paused one.
        If_paused: {
          type: 'If'
          expression: '''@or(equals(body('Read_capacity')?['properties']?['state'], 'Paused'), equals(body('Read_capacity')?['properties']?['state'], 'Suspended'))'''
          actions: {
            Resume_capacity: {
              type: 'Http'
              inputs: { method: 'POST', uri: '${capacityUrl}/resume?${apiVersion}', authentication: identity }
              operationOptions: 'DisableAsyncPattern'
              runAfter: {}
            }
            Until_active: {
              type: 'Until'
              expression: '''@equals(body('Read_state')?['properties']?['state'], 'Active')'''
              limit: { count: 40, timeout: 'PT15M' }
              actions: {
                Wait_15_seconds: {
                  type: 'Wait'
                  inputs: { interval: { count: 15, unit: 'Second' } }
                  runAfter: {}
                }
                Read_state: {
                  type: 'Http'
                  inputs: { method: 'GET', uri: '${capacityUrl}?${apiVersion}', authentication: identity }
                  runAfter: { Wait_15_seconds: [ 'Succeeded' ] }
                }
              }
              runAfter: { Resume_capacity: [ 'Succeeded' ] }
            }
            // An Until loop that reaches its limit doesn't fail, so the run is failed here unless the capacity is active.
            Check_active: {
              type: 'If'
              expression: '''@equals(body('Read_state')?['properties']?['state'], 'Active')'''
              actions: {}
              else: {
                actions: {
                  Capacity_not_active: {
                    type: 'Terminate'
                    inputs: {
                      runStatus: 'Failed'
                      runError: {
                        code: 'CapacityNotActive'
                        message: '''The capacity was asked to resume but is @{body('Read_state')?['properties']?['state']} rather than Active.'''
                      }
                    }
                    runAfter: {}
                  }
                }
              }
              runAfter: { Until_active: [ 'Succeeded', 'Failed', 'TimedOut' ] }
            }
          }
          else: { actions: {} }
          runAfter: { Read_capacity: [ 'Succeeded' ] }
        }
      }
      outputs: {}
    }
  }
}

resource runFailed 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${name}-run-failed'
  location: 'global'
  tags: tags
  properties: {
    description: 'The morning job that resumes the shared Fabric capacity failed, so Fabric may still be paused. Run python3 infra/scripts/fabric_capacity.py resume.'
    severity: 2
    enabled: true
    scopes: [ workflow.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'RunsFailed'
          metricName: 'RunsFailed'
          metricNamespace: 'Microsoft.Logic/workflows'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
        }
      ]
    }
    actions: [ { actionGroupId: alertActionGroupId } ]
  }
}

output workflowId string = workflow.id
output triggerName string = triggerName
output principalId string = workflow.identity.principalId
