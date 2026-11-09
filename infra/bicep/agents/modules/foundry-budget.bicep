// Monthly budget for the version 2 Foundry resource group, with the same alert points as version 1's budget
// (infra/bicep/main.bicep): 50, 75 and 90 percent spent, and a forecast of 100 percent.
param amount int
@description('First day of the budget period, yyyy-MM-01.')
param startDate string
@description('Alert address. When empty, the alerts go to the subscription owners.')
param alertEmail string

var emails = empty(alertEmail) ? [] : [ alertEmail ]
var ownerRoles = empty(alertEmail) ? [ 'Owner' ] : []

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'budget-geobasin-v2-monthly'
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    notifications: {
      actual50: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 50, thresholdType: 'Actual', contactEmails: emails, contactRoles: ownerRoles }
      actual75: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 75, thresholdType: 'Actual', contactEmails: emails, contactRoles: ownerRoles }
      actual90: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 90, thresholdType: 'Actual', contactEmails: emails, contactRoles: ownerRoles }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: emails, contactRoles: ownerRoles }
    }
  }
}
