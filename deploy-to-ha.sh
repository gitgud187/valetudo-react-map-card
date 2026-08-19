#!/usr/bin/env bash
# deploy-to-ha.sh — build and push valetudo-vacuum-map-card to HA
# Usage: ./deploy-to-ha.sh [--restart]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HA_HOST="homeassistant.lan"
HA_PORT=22222
HA_PATH="/mnt/data/supervisor/homeassistant/www/valetudo-vacuum-map-card"
LOCAL_JS="$SCRIPT_DIR/dist/valetudo-react-map-card.js"

echo "==> Building..."
cd "$SCRIPT_DIR"
npm run build

echo "==> Uploading to HA ($HA_HOST)..."
ssh -p "$HA_PORT" root@"$HA_HOST" "mkdir -p $HA_PATH"
cat "$LOCAL_JS" | ssh -p "$HA_PORT" root@"$HA_HOST" \
  "cat > $HA_PATH/valetudo-vacuum-map-card.js && echo 'OK: \$(wc -c < $HA_PATH/valetudo-vacuum-map-card.js) bytes'"

if [[ "${1:-}" == "--restart" ]]; then
  echo "==> Restarting HA Core..."
  ssh -p "$HA_PORT" root@"$HA_HOST" "ha core restart --raw-json"
  echo "==> Restart initiated (wait ~30s for HA to come back)"
fi

echo "==> Done. Hard-refresh browser (Ctrl+Shift+R) to pick up new JS."
