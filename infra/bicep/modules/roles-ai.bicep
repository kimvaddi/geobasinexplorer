// Least-privilege data-plane roles on the AI resources.
// Web identity: inference and index read. Ingestion identity: OCR, embeddings and index write.
// Operator: bootstrap (index creation, smoke tests, data load).
param foundryName string
param docIntelName string
param searchName string
param webPrincipalId string
param ingestPrincipalId string
param operatorObjectId string

var roles = {
  openAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  cogUser: 'a97b65f3-24c7-4388-baec-2e87135dc908'
  searchReader: '1407120a-92aa-4202-b7e9-c0e197c71c8f'
  searchWriter: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  searchService: '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
}
func rd(id string) string => subscriptionResourceId('Microsoft.Authorization/roleDefinitions', id)

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = { name: foundryName }
resource docIntel 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = { name: docIntelName }
resource search 'Microsoft.Search/searchServices@2025-05-01' existing = { name: searchName }

var foundryGrants = [
  { p: webPrincipalId, t: 'ServicePrincipal', r: roles.openAiUser }
  { p: webPrincipalId, t: 'ServicePrincipal', r: roles.cogUser }
  { p: ingestPrincipalId, t: 'ServicePrincipal', r: roles.openAiUser }
  { p: ingestPrincipalId, t: 'ServicePrincipal', r: roles.cogUser }
  { p: operatorObjectId, t: 'User', r: roles.openAiUser }
  { p: operatorObjectId, t: 'User', r: roles.cogUser }
]
resource foundryRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for g in foundryGrants: {
  scope: foundry
  name: guid(foundry.id, g.p, g.r)
  properties: { roleDefinitionId: rd(g.r), principalId: g.p, principalType: g.t }
}]

var diGrants = [
  { p: ingestPrincipalId, t: 'ServicePrincipal', r: roles.cogUser }
  { p: operatorObjectId, t: 'User', r: roles.cogUser }
]
resource diRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for g in diGrants: {
  scope: docIntel
  name: guid(docIntel.id, g.p, g.r)
  properties: { roleDefinitionId: rd(g.r), principalId: g.p, principalType: g.t }
}]

var searchGrants = [
  { p: webPrincipalId, t: 'ServicePrincipal', r: roles.searchReader }
  { p: ingestPrincipalId, t: 'ServicePrincipal', r: roles.searchWriter }
  { p: operatorObjectId, t: 'User', r: roles.searchService }
  { p: operatorObjectId, t: 'User', r: roles.searchWriter }
]
resource searchRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for g in searchGrants: {
  scope: search
  name: guid(search.id, g.p, g.r)
  properties: { roleDefinitionId: rd(g.r), principalId: g.p, principalType: g.t }
}]
