// Parameters for foundry.bicep, exported by infra/scripts/deploy.sh from infra/config/environment.env.
using 'foundry.bicep'

param location = readEnvironmentVariable('GBX_LOCATION', 'westus3')
param operatorObjectId = readEnvironmentVariable('GBX_OPERATOR_OBJECT_ID')
param alertEmail = readEnvironmentVariable('GBX_ALERT_EMAIL', '')
param operatorAddressPrefixes = readEnvironmentVariable('GBX_OPERATOR_CIDRS', '')
param budgetAmount = int(readEnvironmentVariable('GBX_AGENTS_BUDGET_AMOUNT', '300'))
param budgetStartDate = readEnvironmentVariable('GBX_BUDGET_START_DATE')
param fabricIqEndpoint = readEnvironmentVariable('GBX_FABRIC_IQ_ENDPOINT', '')
