// Lets the morning job read and resume the shared Fabric capacity through the custom role in fabric-resume.bicep, and
// nothing else. The assignment sits on the capacity itself rather than on its resource group.
param capacityName string
param principalId string
param roleDefinitionId string

resource capacity 'Microsoft.Fabric/capacities@2023-11-01' existing = {
  name: capacityName
}

resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(capacity.id, principalId, roleDefinitionId)
  scope: capacity
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
    description: 'GeoBasin version 2 morning job: resumes the capacity after the nightly governance pause.'
  }
}
