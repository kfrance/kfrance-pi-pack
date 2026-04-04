#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <name>"
  echo "  Stops, disables, and deletes a pi-cron job."
  exit 1
}

[[ $# -lt 1 ]] && usage

NAME="$1"
SERVICE_NAME="pi-cron-${NAME}"
UNIT_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="${UNIT_DIR}/${SERVICE_NAME}.service"
TIMER_FILE="${UNIT_DIR}/${SERVICE_NAME}.timer"

if [[ ! -f "$TIMER_FILE" ]] && [[ ! -f "$SERVICE_FILE" ]]; then
  echo "Error: no job found with name '${NAME}'."
  echo "Available jobs:"
  ls "${UNIT_DIR}"/pi-cron-*.timer 2>/dev/null | sed 's|.*/pi-cron-||;s|\.timer||' || echo "  (none)"
  exit 1
fi

# Stop and disable
systemctl --user stop "${SERVICE_NAME}.timer" 2>/dev/null || true
systemctl --user disable "${SERVICE_NAME}.timer" 2>/dev/null || true
systemctl --user stop "${SERVICE_NAME}.service" 2>/dev/null || true

# Remove unit files and run script
rm -f "$SERVICE_FILE" "$TIMER_FILE"
rm -f "$HOME/.config/pi-cron/${NAME}.sh"

# Reload
systemctl --user daemon-reload
systemctl --user reset-failed "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl --user reset-failed "${SERVICE_NAME}.timer" 2>/dev/null || true

echo "✅ Removed job '${NAME}'"
