# The workloads: the version 2 web app (gbx-site) with its sign-in, the GDAL/PROJ spatial service, the ingestion and
# evaluation jobs, the live lane's connect and process jobs and the ClamAV scanner. Mirrors infra/bicep/apps.bicep,
# live.bicep, pipeline.bicep and site.bicep. Applied once the images exist (deploy_workloads = true).
locals {
  wl          = var.deploy_workloads ? 1 : 0
  acr         = azurerm_container_registry.acr.login_server
  api_image   = "${local.acr}/gbx-api:${var.release_tag}-${var.brand}"
  pipe_image  = "${local.acr}/gbx-pipeline:${var.release_tag}"
  live_tables = ["sourceregistry", "sourcereviews", "lineage", "silverdocuments", "silverpages", "silverchunks", "pipelinejobs", "sourceversions"]
  common_env = {
    FOUNDRY_ENDPOINT                      = "https://${azapi_resource.foundry.name}.services.ai.azure.com"
    DOCINTEL_ENDPOINT                     = "https://${azurerm_cognitive_account.docintel.custom_subdomain_name}.cognitiveservices.azure.com/"
    SEARCH_ENDPOINT                       = "https://${azurerm_search_service.search.name}.search.windows.net"
    FOUNDRY_PROJECT_ENDPOINT              = "https://${azapi_resource.foundry.name}.services.ai.azure.com/api/projects/geobasin-runtime"
    GBX_AGENT_NAME                        = var.live_agent_name
    GBX_AGENT_VERSION                     = var.live_agent_version
    GBX_LIVE_SOURCES                      = var.live_sources
    GBX_LIVE_ROUTE                        = var.live_route
    STORAGE_ACCOUNT                       = azurerm_storage_account.st.name
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.appi.connection_string
    GBX_VERSION                           = split("-", var.release_tag)[0]
    GBX_AI_ENABLED                        = tostring(var.ai_enabled)
    GBX_MALWARE_SCAN                      = var.malware_scan ? "on" : "off"
    GBX_LIVE_SCAN                         = var.live_scan ? "on" : "off"
    GBX_CAP_USER_QUESTIONS                = tostring(var.questions_per_day)
    GBX_CAP_QUESTIONS                     = tostring(var.questions_per_day)
    GBX_CAP_QUESTIONS_MONTH               = tostring(var.questions_per_day * 30)
    GBX_CAP_TOKENS                        = tostring(var.tokens_per_day)
    GBX_CAP_TOKENS_MONTH                  = tostring(var.tokens_per_day * 30)
  }
  pipeline_env = {
    STORAGE_ACCOUNT                       = azurerm_storage_account.st.name
    FOUNDRY_ENDPOINT                      = local.common_env.FOUNDRY_ENDPOINT
    DOCINTEL_ENDPOINT                     = local.common_env.DOCINTEL_ENDPOINT
    SEARCH_ENDPOINT                       = local.common_env.SEARCH_ENDPOINT
    PURVIEW_ENDPOINT                      = ""
    PURVIEW_COLLECTION_ID                 = ""
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.appi.connection_string
    GBX_AI_ENABLED                        = tostring(var.ai_enabled)
    GBX_LIVE_SCAN                         = var.live_scan ? "on" : "off"
    GBX_PURVIEW                           = "off"
    GBX_CAP_OCR_PAGES                     = "500"
    GBX_CAP_OCR_PAGES_MONTH               = "5000"
    GBX_CAP_TOKENS                        = tostring(var.tokens_per_day)
    GBX_CAP_TOKENS_MONTH                  = tostring(var.tokens_per_day * 30)
  }
}

# ---- Storage the live lane, the scanner and the site add to the platform account --------------------------------------
resource "azurerm_storage_container" "extra" {
  for_each           = toset(["pages", "manifests", "signatures", "site-auth-tokens"])
  name               = each.value
  storage_account_id = azurerm_storage_account.st.id
}

resource "azapi_resource" "extra_queue" {
  for_each  = toset(["scan-jobs", "process-jobs"])
  type      = "Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01"
  parent_id = "${azurerm_storage_account.st.id}/queueServices/default"
  name      = each.value
  body      = { properties = {} }
}

resource "azapi_resource" "extra_table" {
  for_each  = toset(concat(local.live_tables, ["sitereviews", "sitefeedback", "sitetoolruns"]))
  type      = "Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01"
  parent_id = "${azurerm_storage_account.st.id}/tableServices/default"
  name      = each.value
  body      = { properties = {} }
}

resource "azurerm_user_assigned_identity" "workload" {
  for_each            = toset(["pipeline", "scan", "sigs", "site-agents", "site-fabric"])
  name                = "id-gbx-${each.value}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg["app"].name
  tags                = local.tags
}

locals {
  pipeline = azurerm_user_assigned_identity.workload["pipeline"].principal_id
  scan     = azurerm_user_assigned_identity.workload["scan"].principal_id
  sigs     = azurerm_user_assigned_identity.workload["sigs"].principal_id
  workload_assignments = {
    pipeline_pull       = { scope = azurerm_container_registry.acr.id, role = "acr_pull", principal = local.pipeline }
    scan_pull           = { scope = azurerm_container_registry.acr.id, role = "acr_pull", principal = local.scan }
    sigs_pull           = { scope = azurerm_container_registry.acr.id, role = "acr_pull", principal = local.sigs }
    pipeline_quarantine = { scope = azurerm_storage_container.c["quarantine"].id, role = "blob_contributor", principal = local.pipeline }
    pipeline_raw        = { scope = azurerm_storage_container.c["raw"].id, role = "blob_contributor", principal = local.pipeline }
    pipeline_processed  = { scope = azurerm_storage_container.c["processed"].id, role = "blob_contributor", principal = local.pipeline }
    pipeline_pages      = { scope = azurerm_storage_container.extra["pages"].id, role = "blob_contributor", principal = local.pipeline }
    pipeline_manifests  = { scope = azurerm_storage_container.extra["manifests"].id, role = "blob_contributor", principal = local.pipeline }
    pipeline_proc_q     = { scope = azapi_resource.extra_queue["process-jobs"].id, role = "queue_processor", principal = local.pipeline }
    pipeline_proc_read  = { scope = azapi_resource.extra_queue["process-jobs"].id, role = "queue_reader", principal = local.pipeline }
    pipeline_proc_send  = { scope = azapi_resource.extra_queue["process-jobs"].id, role = "queue_sender", principal = local.pipeline }
    pipeline_scan_send  = { scope = azapi_resource.extra_queue["scan-jobs"].id, role = "queue_sender", principal = local.pipeline }
    pipeline_tables     = { scope = azurerm_storage_account.st.id, role = "table_contributor", principal = local.pipeline }
    pipeline_ocr        = { scope = azurerm_cognitive_account.docintel.id, role = "cognitive_user", principal = local.pipeline }
    pipeline_embed      = { scope = azapi_resource.foundry.id, role = "openai_user", principal = local.pipeline }
    pipeline_search     = { scope = azurerm_search_service.search.id, role = "search_contributor", principal = local.pipeline }
    web_scan_send       = { scope = azapi_resource.extra_queue["scan-jobs"].id, role = "queue_sender", principal = local.web }
    web_proc_send       = { scope = azapi_resource.extra_queue["process-jobs"].id, role = "queue_sender", principal = local.web }
    web_pages           = { scope = azurerm_storage_container.extra["pages"].id, role = "blob_reader", principal = local.web }
    web_manifests       = { scope = azurerm_storage_container.extra["manifests"].id, role = "blob_reader", principal = local.web }
    scan_quarantine     = { scope = azurerm_storage_container.c["quarantine"].id, role = "blob_contributor", principal = local.scan }
    scan_signatures     = { scope = azurerm_storage_container.extra["signatures"].id, role = "blob_reader", principal = local.scan }
    scan_queue_read     = { scope = azapi_resource.extra_queue["scan-jobs"].id, role = "queue_reader", principal = local.scan }
    scan_queue_proc     = { scope = azapi_resource.extra_queue["scan-jobs"].id, role = "queue_processor", principal = local.scan }
    scan_ingest_send    = { scope = azapi_resource.queue["ingest-jobs"].id, role = "queue_sender", principal = local.scan }
    scan_proc_send      = { scope = azapi_resource.extra_queue["process-jobs"].id, role = "queue_sender", principal = local.scan }
    sigs_signatures     = { scope = azurerm_storage_container.extra["signatures"].id, role = "blob_contributor", principal = local.sigs }
    site_token_store    = { scope = azurerm_storage_container.extra["site-auth-tokens"].id, role = "blob_contributor", principal = azurerm_user_assigned_identity.workload["site-agents"].principal_id }
  }
}

resource "azurerm_role_assignment" "workload" {
  for_each           = local.workload_assignments
  scope              = each.value.scope
  role_definition_id = local.role_id[each.value.role]
  principal_id       = each.value.principal
  principal_type     = "ServicePrincipal"
}

# ---- Spatial service ---------------------------------------------------------------------------------------------------
resource "azurerm_container_app" "spatial" {
  count                        = local.wl
  name                         = "gbx-spatial"
  container_app_environment_id = azurerm_container_app_environment.cae.id
  resource_group_name          = azurerm_resource_group.rg["app"].name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = merge(local.tags, { layer = "app" })
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.id["spatial"].id]
  }
  registry {
    server   = local.acr
    identity = azurerm_user_assigned_identity.id["spatial"].id
  }
  ingress {
    external_enabled = false
    target_port      = 8080
    transport        = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
  template {
    min_replicas = 1
    max_replicas = 2
    container {
      name   = "spatial"
      image  = "${local.acr}/gbx-spatial:${var.release_tag}"
      cpu    = 0.25
      memory = "0.5Gi"
      startup_probe {
        transport               = "HTTP"
        path                    = "/health"
        port                    = 8080
        interval_seconds        = 5
        failure_count_threshold = 24
      }
      liveness_probe {
        transport               = "HTTP"
        path                    = "/health"
        port                    = 8080
        interval_seconds        = 30
        failure_count_threshold = 3
      }
    }
  }
}

# ---- The web app: UI, API and the scientists' tool server -------------------------------------------------------------
resource "azurerm_container_app" "site" {
  count                        = local.wl
  name                         = "gbx-site"
  container_app_environment_id = azurerm_container_app_environment.cae.id
  resource_group_name          = azurerm_resource_group.rg["app"].name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = merge(local.tags, { layer = "site", version = "2" })
  identity {
    type = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.id["web"].id, azurerm_user_assigned_identity.id["maps"].id,
    azurerm_user_assigned_identity.workload["site-agents"].id, azurerm_user_assigned_identity.workload["site-fabric"].id]
  }
  registry {
    server   = local.acr
    identity = azurerm_user_assigned_identity.id["web"].id
  }
  secret {
    name  = "microsoft-provider-authentication-secret"
    value = var.site_app_secret
  }
  secret {
    name  = "run-ticket-key"
    value = var.run_ticket_key
  }
  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
  template {
    min_replicas = 1
    max_replicas = 2
    http_scale_rule {
      name                = "http"
      concurrent_requests = "30"
    }
    container {
      name   = "web"
      image  = local.api_image
      cpu    = 0.5
      memory = "1Gi"
      dynamic "env" {
        for_each = merge(local.common_env, {
          AZURE_CLIENT_ID          = azurerm_user_assigned_identity.id["web"].client_id
          GBX_OWNERS               = ""
          GBX_REQUIRE_AUTH         = "true"
          GBX_SELF_URL             = local.site_url
          GBX_CANONICAL_HOST       = var.site_host
          MAPS_ACCOUNT_CLIENT_ID   = azapi_resource.maps.output.properties.uniqueId
          MAPS_IDENTITY_CLIENT_ID  = azurerm_user_assigned_identity.id["maps"].client_id
          GBX_SPATIAL_URL          = "https://${azurerm_container_app.spatial[0].ingress[0].fqdn}"
          GBX_DATA_SCOPE           = "site"
          GBX_TOOL_SERVER          = "on"
          GBX_TOOL_CALLERS         = join(",", var.agent_identities)
          GBX_V2_SCIENTISTS        = "on"
          GBX_V2_PROJECT_ENDPOINT  = "https://${azapi_resource.v2_account.name}.services.ai.azure.com/api/projects/${azapi_resource.v2_project.name}"
          GBX_V2_COSCIENTIST_AGENT = "gbx-coscientist"
          GBX_V2_AGENTS_CLIENT_ID  = azurerm_user_assigned_identity.workload["site-agents"].client_id
          GBX_V2_COPILOT           = "on"
          GBX_V2_COPILOT_AGENT     = "gbx-copilot"
          GBX_V2_FABRIC_WORKSPACE  = var.fabric_workspace_id
          GBX_V2_FABRIC_GRAPH      = var.fabric_graph_model_id
          GBX_V2_FABRIC_CLIENT_ID  = azurerm_user_assigned_identity.workload["site-fabric"].client_id
          GBX_OBO_CLIENT_ID        = var.site_app_id
          GBX_OBO_TENANT_ID        = data.azurerm_client_config.current.tenant_id
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name        = "GBX_RUN_TICKET_KEY"
        secret_name = "run-ticket-key"
      }
      startup_probe {
        transport               = "HTTP"
        path                    = "/api/health"
        port                    = 8080
        interval_seconds        = 5
        failure_count_threshold = 24
      }
    }
  }
  lifecycle {
    precondition {
      condition     = var.site_app_id != "" && var.site_app_secret != "" && var.run_ticket_key != "" && var.release_tag != ""
      error_message = "Set site_app_id, site_app_secret (TF_VAR_site_app_secret), run_ticket_key (TF_VAR_run_ticket_key) and release_tag before deploying the workloads."
    }
  }
}

# Sign-in in front of every request, with the token store the API uses to call the scientists as the signed-in person.
resource "azapi_resource" "site_auth" {
  count     = local.wl
  type      = "Microsoft.App/containerApps/authConfigs@2026-07-01"
  parent_id = azurerm_container_app.site[0].id
  name      = "current"
  body = {
    properties = {
      platform         = { enabled = true }
      globalValidation = { unauthenticatedClientAction = "RedirectToLoginPage", redirectToProvider = "azureactivedirectory" }
      identityProviders = {
        azureActiveDirectory = {
          enabled = true
          registration = {
            clientId                = var.site_app_id
            clientSecretSettingName = "microsoft-provider-authentication-secret"
            openIdIssuer            = "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/v2.0"
          }
          login = { loginParameters = ["scope=openid profile email offline_access api://${var.site_app_id}/user_impersonation"] }
          validation = {
            allowedAudiences           = ["api://${var.site_app_id}", var.site_app_id]
            defaultAuthorizationPolicy = { allowedApplications = concat([var.site_app_id, "04b07795-8ddb-461a-bbee-02f9e1bf7b46"], var.agent_identities) }
          }
        }
      }
      login = {
        tokenStore = {
          enabled          = true
          azureBlobStorage = { blobContainerUri = "${azurerm_storage_account.st.primary_blob_endpoint}site-auth-tokens", clientId = azurerm_user_assigned_identity.workload["site-agents"].client_id }
        }
      }
    }
  }
  schema_validation_enabled = false
}

# ---- Jobs --------------------------------------------------------------------------------------------------------------
resource "azurerm_container_app_job" "ingest" {
  count                        = local.wl
  name                         = "gbx-ingest"
  location                     = var.location
  resource_group_name          = azurerm_resource_group.rg["app"].name
  container_app_environment_id = azurerm_container_app_environment.cae.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 1800
  tags                         = local.tags
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.id["ingest"].id]
  }
  registry {
    server   = local.acr
    identity = azurerm_user_assigned_identity.id["ingest"].id
  }
  event_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
    scale {
      min_executions              = 0
      max_executions              = 2
      polling_interval_in_seconds = 30
      rules {
        name             = "ingest-queue"
        custom_rule_type = "azure-queue"
        metadata         = { accountName = azurerm_storage_account.st.name, queueName = "ingest-jobs", queueLength = "1", queueLengthStrategy = "visibleonly" }
        identity_id      = azurerm_user_assigned_identity.id["ingest"].id
      }
    }
  }
  template {
    container {
      name    = "worker"
      image   = local.api_image
      command = ["node", "dist/worker.mjs"]
      cpu     = 1
      memory  = "2Gi"
      dynamic "env" {
        for_each = merge(local.common_env, { AZURE_CLIENT_ID = azurerm_user_assigned_identity.id["ingest"].client_id })
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

resource "azurerm_container_app_job" "manual" {
  for_each = var.deploy_workloads ? {
    "gbx-eval"    = { image = local.api_image, command = ["node", "dist/scripts/eval.mjs"], args = ["benchmarks"], identity = azurerm_user_assigned_identity.id["web"], cpu = 0.5, memory = "1Gi", timeout = 3600, env = local.common_env }
    "gbx-connect" = { image = local.pipe_image, command = ["node", "dist/scripts/live-connect.mjs"], args = [], identity = azurerm_user_assigned_identity.workload["pipeline"], cpu = 1, memory = "2Gi", timeout = 300, env = local.pipeline_env }
  } : {}
  name                         = each.key
  location                     = var.location
  resource_group_name          = azurerm_resource_group.rg["app"].name
  container_app_environment_id = azurerm_container_app_environment.cae.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = each.value.timeout
  replica_retry_limit          = 0
  tags                         = local.tags
  identity {
    type         = "UserAssigned"
    identity_ids = [each.value.identity.id]
  }
  registry {
    server   = local.acr
    identity = each.value.identity.id
  }
  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }
  template {
    container {
      name    = "main"
      image   = each.value.image
      command = each.value.command
      args    = each.value.args
      cpu     = each.value.cpu
      memory  = each.value.memory
      dynamic "env" {
        for_each = merge(each.value.env, { AZURE_CLIENT_ID = each.value.identity.client_id })
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

resource "azurerm_container_app_job" "queue" {
  for_each = var.deploy_workloads ? {
    "gbx-process" = { image = local.pipe_image, command = ["node", "dist/scripts/live-process.mjs"], args = [], queue = "process-jobs", identity = azurerm_user_assigned_identity.workload["pipeline"], cpu = 2, memory = "4Gi", timeout = 39600, env = local.pipeline_env }
    "gbx-scan"    = { image = "${local.acr}/gbx-scanner:${var.release_tag}", command = ["python3", "/app/scan.py"], args = [], queue = "scan-jobs", identity = azurerm_user_assigned_identity.workload["scan"], cpu = 1, memory = "2Gi", timeout = 900, env = { STORAGE_ACCOUNT = azurerm_storage_account.st.name, GBX_NEXT_QUEUE = "ingest-jobs", GBX_ROUTES = "ingest-jobs,process-jobs" } }
  } : {}
  name                         = each.key
  location                     = var.location
  resource_group_name          = azurerm_resource_group.rg["app"].name
  container_app_environment_id = azurerm_container_app_environment.cae.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = each.value.timeout
  tags                         = local.tags
  identity {
    type         = "UserAssigned"
    identity_ids = [each.value.identity.id]
  }
  registry {
    server   = local.acr
    identity = each.value.identity.id
  }
  event_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
    scale {
      min_executions              = 0
      max_executions              = 1
      polling_interval_in_seconds = 30
      rules {
        name             = "${each.value.queue}-rule"
        custom_rule_type = "azure-queue"
        metadata         = { accountName = azurerm_storage_account.st.name, queueName = each.value.queue, queueLength = "1", queueLengthStrategy = "visibleonly" }
        identity_id      = each.value.identity.id
      }
    }
  }
  template {
    container {
      name    = "main"
      image   = each.value.image
      command = each.value.command
      args    = each.value.args
      cpu     = each.value.cpu
      memory  = each.value.memory
      dynamic "env" {
        for_each = merge(each.value.env, { AZURE_CLIENT_ID = each.value.identity.client_id })
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

resource "azurerm_container_app_job" "signatures" {
  count                        = local.wl
  name                         = "gbx-sigs"
  location                     = var.location
  resource_group_name          = azurerm_resource_group.rg["app"].name
  container_app_environment_id = azurerm_container_app_environment.cae.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 900
  tags                         = local.tags
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.workload["sigs"].id]
  }
  registry {
    server   = local.acr
    identity = azurerm_user_assigned_identity.workload["sigs"].id
  }
  schedule_trigger_config {
    cron_expression          = "0 */6 * * *"
    parallelism              = 1
    replica_completion_count = 1
  }
  template {
    container {
      name    = "signatures"
      image   = "${local.acr}/gbx-scanner:${var.release_tag}"
      command = ["python3", "/app/scan.py"]
      args    = ["--update-signatures"]
      cpu     = 0.5
      memory  = "1Gi"
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.workload["sigs"].client_id
      }
      env {
        name  = "STORAGE_ACCOUNT"
        value = azurerm_storage_account.st.name
      }
    }
  }
}
