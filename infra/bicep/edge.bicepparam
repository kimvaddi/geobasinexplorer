// Parameters for edge.bicep (Front Door Premium, WAF and the public domain), deployed into rg-geobasin-edge by
// infra/scripts/deploy.sh edge, which exports these values from infra/config/environment.env and the foundation outputs.
using 'edge.bicep'

param sfx = readEnvironmentVariable('GBX_SUFFIX')
param zoneName = readEnvironmentVariable('GBX_DNS_ZONE')
param canonicalHost = readEnvironmentVariable('GBX_SITE_HOST')
param environmentId = readEnvironmentVariable('GBX_ENVIRONMENT_ID')
param originHostName = readEnvironmentVariable('GBX_SITE_FQDN')
param logAnalyticsId = readEnvironmentVariable('GBX_LOG_ANALYTICS_ID')
// false for the first rollout; true once both domains are validated and the Private Link connection is approved.
param cutover = bool(readEnvironmentVariable('GBX_EDGE_CUTOVER', 'false'))
