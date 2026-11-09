# GeoBasin Explorer AI version 2 in Terraform: the same platform as infra/bicep, for organisations that standardise on
# Terraform. azurerm manages the mainstream resources; azapi manages the newer Azure AI Foundry, Fabric, network security
# perimeter and Container Apps sign-in resources at the same API versions the Bicep templates use.
terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.20"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.4"
    }
  }
  # Configure a remote backend before a shared or production deployment, for example:
  # backend "azurerm" {
  #   resource_group_name  = "rg-tfstate"
  #   storage_account_name = "<state account>"
  #   container_name       = "tfstate"
  #   key                  = "geobasin.tfstate"
  #   use_azuread_auth     = true
  # }
}

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
    cognitive_account {
      purge_soft_delete_on_destroy = false
    }
  }
}

provider "azurerm" {
  alias               = "agents"
  subscription_id     = coalesce(var.agents_subscription_id, var.subscription_id)
  storage_use_azuread = true
  features {}
}

provider "azapi" {}
