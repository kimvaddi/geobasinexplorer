# The public edge (infra/bicep/edge.bicep): an Azure DNS zone, Front Door Premium with a WAF, managed certificates for
# the site host and the zone apex, and Private Link to the Container Apps environment, whose public access is off. The
# apex redirects to the site host, and identity headers a caller might forge are stripped before they reach the app.
locals {
  edge       = var.deploy_edge ? 1 : 0
  site_label = trimsuffix(var.site_host, ".${var.dns_zone}")
  esri_tiles = "^(?:https?://[^/]+)?/api/basemap/esri/[a-z]+/[0-9]+/[0-9]+/[0-9]+$"
  identity_headers = [
    ["x-ms-client-principal", "x-ms-client-principal-id", "x-ms-client-principal-name", "x-ms-client-principal-idp", "x-ms-token-aad-id-token"],
    ["x-ms-token-aad-access-token", "x-ms-token-aad-refresh-token", "x-ms-token-aad-expires-on"],
  ]
}

resource "azurerm_dns_zone" "zone" {
  count               = local.edge
  name                = var.dns_zone
  resource_group_name = azurerm_resource_group.rg["edge"].name
  tags                = merge(local.tags, { layer = "edge" })
}

resource "azapi_resource" "waf" {
  count     = local.edge
  type      = "Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2025-03-01"
  parent_id = azurerm_resource_group.rg["edge"].id
  name      = "wafgbx${local.sfx}"
  location  = "Global"
  tags      = merge(local.tags, { layer = "edge" })
  body = {
    sku = { name = "Premium_AzureFrontDoor" }
    properties = {
      policySettings = { enabledState = "Enabled", mode = "Prevention", requestBodyCheck = "Enabled", customBlockResponseStatusCode = 403 }
      customRules = {
        rules = [
          {
            name                       = "RateLimitPerClient", priority = 100, enabledState = "Enabled", ruleType = "RateLimitRule", action = "Block"
            rateLimitDurationInMinutes = 1, rateLimitThreshold = 600
            matchConditions = [
              { matchVariable = "RequestUri", operator = "Contains", matchValue = ["/"] },
              { matchVariable = "RequestUri", operator = "RegEx", negateCondition = true, matchValue = [local.esri_tiles], transforms = ["Lowercase"] },
            ]
          },
          {
            name                       = "RateLimitEsriTiles", priority = 110, enabledState = "Enabled", ruleType = "RateLimitRule", action = "Block"
            rateLimitDurationInMinutes = 1, rateLimitThreshold = 3000
            matchConditions            = [{ matchVariable = "RequestUri", operator = "RegEx", matchValue = [local.esri_tiles], transforms = ["Lowercase"] }]
          },
        ]
      }
      managedRules = {
        managedRuleSets = [
          { ruleSetType = "Microsoft_DefaultRuleSet", ruleSetVersion = "2.2", ruleSetAction = "Block" },
          { ruleSetType = "Microsoft_BotManagerRuleSet", ruleSetVersion = "1.1" },
        ]
      }
    }
  }
}

resource "azurerm_cdn_frontdoor_profile" "afd" {
  count                    = local.edge
  name                     = "afd-gbx-${local.sfx}"
  resource_group_name      = azurerm_resource_group.rg["edge"].name
  sku_name                 = "Premium_AzureFrontDoor"
  response_timeout_seconds = 120
  tags                     = merge(local.tags, { layer = "edge" })
}

resource "azurerm_cdn_frontdoor_endpoint" "endpoint" {
  count                    = local.edge
  name                     = "gbx-${local.sfx}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.afd[0].id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_origin_group" "web" {
  count                    = local.edge
  name                     = "web"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.afd[0].id
  session_affinity_enabled = false
  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }
  health_probe {
    path                = "/api/health"
    protocol            = "Https"
    request_type        = "GET"
    interval_in_seconds = 60
  }
}

resource "azurerm_cdn_frontdoor_origin" "site" {
  count                          = local.edge * local.wl
  name                           = "gbx-site"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.web[0].id
  enabled                        = true
  host_name                      = azurerm_container_app.site[0].ingress[0].fqdn
  origin_host_header             = azurerm_container_app.site[0].ingress[0].fqdn
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000
  certificate_name_check_enabled = true
  private_link {
    request_message        = "GeoBasin Explorer AI Front Door"
    target_type            = "managedEnvironments"
    location               = var.location
    private_link_target_id = azurerm_container_app_environment.cae.id
  }
}

resource "azurerm_cdn_frontdoor_custom_domain" "domain" {
  for_each                 = var.deploy_edge ? { site = var.site_host, apex = var.dns_zone } : {}
  name                     = replace(each.value, ".", "-")
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.afd[0].id
  dns_zone_id              = azurerm_dns_zone.zone[0].id
  host_name                = each.value
  tls {
    certificate_type = "ManagedCertificate"
  }
}

resource "azurerm_dns_txt_record" "validation" {
  for_each            = azurerm_cdn_frontdoor_custom_domain.domain
  name                = each.key == "apex" ? "_dnsauth" : "_dnsauth.${local.site_label}"
  zone_name           = azurerm_dns_zone.zone[0].name
  resource_group_name = azurerm_resource_group.rg["edge"].name
  ttl                 = 3600
  record {
    value = each.value.validation_token
  }
}

resource "azurerm_cdn_frontdoor_rule_set" "canonical" {
  count                    = local.edge
  name                     = "canonical"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.afd[0].id
}

resource "azurerm_cdn_frontdoor_rule" "strip_identity" {
  count                     = var.deploy_edge ? length(local.identity_headers) : 0
  name                      = "stripIdentityHeaders${count.index + 1}"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.canonical[0].id
  order                     = count.index + 1
  behavior_on_match         = "Continue"
  conditions {
    request_uri_condition {
      operator = "Any"
    }
  }
  actions {
    dynamic "request_header_action" {
      for_each = local.identity_headers[count.index]
      content {
        header_action = "Delete"
        header_name   = request_header_action.value
      }
    }
  }
}

resource "azurerm_cdn_frontdoor_rule" "apex_redirect" {
  count                     = local.edge
  name                      = "apexToSite"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.canonical[0].id
  order                     = 3
  behavior_on_match         = "Stop"
  conditions {
    host_name_condition {
      operator     = "Equal"
      match_values = [var.dns_zone]
      transforms   = ["Lowercase"]
    }
  }
  actions {
    url_redirect_action {
      redirect_type        = "Moved"
      redirect_protocol    = "Https"
      destination_hostname = var.site_host
    }
  }
  depends_on = [azurerm_cdn_frontdoor_rule.strip_identity]
}

resource "azurerm_cdn_frontdoor_route" "web" {
  count                           = local.edge * local.wl
  name                            = "web"
  cdn_frontdoor_endpoint_id       = azurerm_cdn_frontdoor_endpoint.endpoint[0].id
  cdn_frontdoor_origin_group_id   = azurerm_cdn_frontdoor_origin_group.web[0].id
  cdn_frontdoor_origin_ids        = [azurerm_cdn_frontdoor_origin.site[0].id]
  cdn_frontdoor_rule_set_ids      = [azurerm_cdn_frontdoor_rule_set.canonical[0].id]
  cdn_frontdoor_custom_domain_ids = [for d in azurerm_cdn_frontdoor_custom_domain.domain : d.id]
  supported_protocols             = ["Http", "Https"]
  patterns_to_match               = ["/*"]
  forwarding_protocol             = "HttpsOnly"
  https_redirect_enabled          = true
  link_to_default_domain          = false
  depends_on                      = [azurerm_cdn_frontdoor_rule.apex_redirect]
}

resource "azurerm_cdn_frontdoor_custom_domain_association" "domain" {
  for_each                       = local.edge * local.wl == 1 ? azurerm_cdn_frontdoor_custom_domain.domain : {}
  cdn_frontdoor_custom_domain_id = each.value.id
  cdn_frontdoor_route_ids        = [azurerm_cdn_frontdoor_route.web[0].id]
}

resource "azurerm_cdn_frontdoor_security_policy" "waf" {
  count                    = local.edge
  name                     = "waf"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.afd[0].id
  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azapi_resource.waf[0].id
      association {
        patterns_to_match = ["/*"]
        dynamic "domain" {
          for_each = azurerm_cdn_frontdoor_custom_domain.domain
          content {
            cdn_frontdoor_domain_id = domain.value.id
          }
        }
      }
    }
  }
}

# Pointed at Front Door only at cut-over, once both domains validate and the Private Link connection is approved.
resource "azurerm_dns_cname_record" "site" {
  count               = var.deploy_edge && var.edge_cutover ? 1 : 0
  name                = local.site_label
  zone_name           = azurerm_dns_zone.zone[0].name
  resource_group_name = azurerm_resource_group.rg["edge"].name
  ttl                 = 300
  record              = azurerm_cdn_frontdoor_endpoint.endpoint[0].host_name
}

resource "azurerm_dns_a_record" "apex" {
  count               = var.deploy_edge && var.edge_cutover ? 1 : 0
  name                = "@"
  zone_name           = azurerm_dns_zone.zone[0].name
  resource_group_name = azurerm_resource_group.rg["edge"].name
  ttl                 = 300
  target_resource_id  = azurerm_cdn_frontdoor_endpoint.endpoint[0].id
}

resource "azurerm_monitor_diagnostic_setting" "afd" {
  count                      = local.edge
  name                       = "afd-logs"
  target_resource_id         = azurerm_cdn_frontdoor_profile.afd[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
  enabled_log {
    category_group = "allLogs"
  }
}
