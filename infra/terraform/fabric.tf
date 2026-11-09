# The Microsoft Fabric capacity behind the knowledge workspace (infra/bicep/agents/fabric-capacity.bicep). The workspace,
# lakehouse, ontology and graph model are Fabric items, created by infra/scripts/fabric_workspace.py and the ingestion
# framework rather than by Azure Resource Manager.
resource "azurerm_resource_group" "fabric" {
  count    = var.fabric_capacity_create ? 1 : 0
  provider = azurerm.agents
  name     = "rg-geobasin-fabric"
  location = var.location
  tags     = merge(local.tags, { layer = "fabric", version = "2" })
}

resource "azapi_resource" "fabric_capacity" {
  count     = var.fabric_capacity_create ? 1 : 0
  type      = "Microsoft.Fabric/capacities@2023-11-01"
  parent_id = azurerm_resource_group.fabric[0].id
  name      = var.fabric_capacity_name
  location  = var.location
  tags      = merge(local.tags, { layer = "fabric", version = "2" })
  body = {
    sku        = { name = var.fabric_capacity_sku, tier = "Fabric" }
    properties = { administration = { members = var.fabric_admins } }
  }
  lifecycle {
    precondition {
      condition     = length(var.fabric_admins) > 0
      error_message = "Name at least one Fabric capacity administrator in fabric_admins."
    }
  }
}
