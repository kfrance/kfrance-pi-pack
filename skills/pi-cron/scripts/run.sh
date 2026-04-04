#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <name>"
  echo "  Manually trigger a pi-cron job immediately."
  exit 1
}

[[ $# -lt 1 ]] && usage

NAME="$1"
SERVICE_NAME="pi-cron-${NAME}"
UNIT_DIR="$HOME/.config/systemd/user"

if [[ ! -f "${UNIT_DIR}/${SERVICE_NAME}.service" ]]; then
  echo "Error: no job found with name '${NAME}'."
  exit 1
fi

echo "Running '${NAME}' now..."
systemctl --user start "${SERVICE_NAME}.service"

echo "✅ Triggered. View output with:"
echo "   journalctl --user -u ${SERVICE_NAME}.service --no-pager -n 50"
