#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <name>"
  echo "  Show status of a pi-cron job (timer + last service run)."
  exit 1
}

[[ $# -lt 1 ]] && usage

NAME="$1"
SERVICE_NAME="pi-cron-${NAME}"

echo "=== Timer ==="
systemctl --user status "${SERVICE_NAME}.timer" --no-pager 2>&1 || true

echo ""
echo "=== Service (last run) ==="
systemctl --user status "${SERVICE_NAME}.service" --no-pager 2>&1 || true
