#!/usr/bin/env bash
# Connects the Esri base maps (services/api/src/esri.ts) to the running web app, or disconnects them.
#   infra/scripts/esri-key.sh                    asks for an ArcGIS Location Platform API key (input hidden: paste it and press
#                                        Enter), stores it as the gbx-site secret esri-api-key and points ESRI_API_KEY at
#                                        it, which starts a new revision
#   infra/scripts/esri-key.sh --from-clipboard   the same, reading the key you just copied (macOS), then clearing the clipboard
#   infra/scripts/esri-key.sh --remove           removes both, so the menu offers the Azure base maps alone
# Run it again with a new key to replace one: the secret is updated and the running revision restarted.
# The key is never printed or written to disk, and infra/scripts/deploy-site.sh carries it into later deployments.
# Learn: https://learn.microsoft.com/azure/container-apps/manage-secrets
set -euo pipefail
. "$(dirname "$0")/lib.sh"
RG="$APP_RG"
APPS=(gbx-site)
if [ "${1:-}" = "--remove" ]; then
  for APP in "${APPS[@]}"; do
    # The setting goes first, because a secret can't be removed while a setting still refers to it.
    az containerapp update --subscription "$SUB" -g "$RG" -n "$APP" --remove-env-vars ESRI_API_KEY -o none
    az containerapp secret remove --subscription "$SUB" -g "$RG" -n "$APP" --secret-names esri-api-key -o none
    echo "Esri base maps disconnected from $APP."
  done
else
  if [ "${1:-}" = "--from-clipboard" ]; then
    KEY="$(pbpaste | tr -d '[:space:]')"
    pbcopy < /dev/null
    echo "Read the key from the clipboard and cleared the clipboard."
  else
    read -r -s -p "ArcGIS Location Platform API key (input hidden; paste it and press Enter): " KEY
    echo
  fi
  # A key is one long token; this catches an empty clipboard or a copied item ID without ever showing the key.
  if [ "${#KEY}" -lt 40 ] || [[ "$KEY" =~ [[:space:]] ]]; then
    echo "That isn't an ArcGIS API key (it is ${#KEY} characters long), so nothing changed." >&2
    unset KEY; false
  fi
  case "$KEY" in AAP*) ;; *) echo "Note: ArcGIS API keys usually begin with AAP; continuing anyway." >&2 ;; esac
  for APP in "${APPS[@]}"; do
    echo "Storing a key of ${#KEY} characters as a secret on $APP..."
    az containerapp secret set --subscription "$SUB" -g "$RG" -n "$APP" --secrets "esri-api-key=$KEY" -o none --only-show-errors
    HAS="$(az containerapp show --subscription "$SUB" -g "$RG" -n "$APP" --query "properties.template.containers[0].env[?name=='ESRI_API_KEY'].secretRef | [0]" -o tsv)"
    REV="$(az containerapp show --subscription "$SUB" -g "$RG" -n "$APP" --query properties.latestRevisionName -o tsv)"
    if [ "$HAS" = "esri-api-key" ]; then
      # Replacing a key: a changed secret reaches a running revision only after a restart
      # (Learn: https://learn.microsoft.com/azure/container-apps/revisions-manage#revision-restart).
      az containerapp revision restart --subscription "$SUB" -g "$RG" -n "$APP" --revision "$REV" -o none --only-show-errors
      echo "Esri key replaced on $APP; revision $REV restarted to pick it up."
    else
      az containerapp update --subscription "$SUB" -g "$RG" -n "$APP" --set-env-vars "ESRI_API_KEY=secretref:esri-api-key" -o none --only-show-errors
      REV="$(az containerapp show --subscription "$SUB" -g "$RG" -n "$APP" --query properties.latestRevisionName -o tsv)"
      echo "Esri key stored as a secret on $APP; revision $REV is starting. In a minute or two the base-map menu should list Esri ArcGIS."
    fi
  done
  unset KEY
fi
