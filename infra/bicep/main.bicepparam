// Parameters for main.bicep. infra/scripts/deploy.sh exports every value from infra/config/environment.env, so
// nothing environment-specific or secret is kept in this file.
using 'main.bicep'

param location = readEnvironmentVariable('GBX_LOCATION', 'westus3')
param operatorObjectId = readEnvironmentVariable('GBX_OPERATOR_OBJECT_ID')
param alertEmail = readEnvironmentVariable('GBX_ALERT_EMAIL')
param budgetAmount = int(readEnvironmentVariable('GBX_BUDGET_AMOUNT', '1500'))
param budgetStartDate = readEnvironmentVariable('GBX_BUDGET_START_DATE')
param mapsLocation = readEnvironmentVariable('GBX_MAPS_LOCATION', 'westus2')
param publicOrigin = readEnvironmentVariable('GBX_SITE_URL')
param additionalOrigins = filter(split(readEnvironmentVariable('GBX_ADDITIONAL_ORIGINS', ''), ','), o => !empty(trim(o)))
param ownerTag = readEnvironmentVariable('GBX_OWNER_TAG', 'platform-team')
param answerCapacity = int(readEnvironmentVariable('GBX_ANSWER_CAPACITY', '100'))
param validatorCapacity = int(readEnvironmentVariable('GBX_VALIDATOR_CAPACITY', '100'))
param embedCapacity = int(readEnvironmentVariable('GBX_EMBED_CAPACITY', '300'))
