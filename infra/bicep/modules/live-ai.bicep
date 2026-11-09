// Roles on the existing AI resources; no new model, Search service, agent or endpoint is created.
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/ai-machine-learning
// https://learn.microsoft.com/azure/search/search-security-rbac#grant-access-to-a-single-index
// https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry
param foundryName string
param docIntelName string
param searchName string
param pipelinePrincipalId string
param webPrincipalId string
resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = { name: foundryName }
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' existing = { parent: foundry, name: 'geobasin-runtime' }
resource di 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = { name: docIntelName }
resource search 'Microsoft.Search/searchServices@2025-05-01' existing = { name: searchName }
// Search documents/indexes are data-plane objects, but index-scoped RBAC uses this documented virtual ARM scope.
#disable-next-line BCP081
resource evidence 'Microsoft.Search/searchServices/indexes@2025-05-01' existing = { parent: search, name: 'gbx-evidence-v2' }
resource ocr 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: di
  name: guid(di.id, pipelinePrincipalId, 'a97b65f3-24c7-4388-baec-2e87135dc908')
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908') }
}
resource embedding 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, pipelinePrincipalId, '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd') }
}
resource writer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: evidence
  name: guid(evidence.id, pipelinePrincipalId, '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8ebe5a00-799e-43f5-93ac-243d3dce84a7') }
}
resource webFoundryUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: project
  name: guid(project.id, webPrincipalId, '53ca6127-db72-4b80-b1b0-d745d6d5456d')
  properties: { principalId: webPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d') }
}
