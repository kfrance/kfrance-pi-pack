#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <name> [--schedule <expr>] [--prompt <text>] [--pi-flags <flags>]"
  echo ""
  echo "  Edit an existing pi-cron job. Only specified fields are changed."
  echo ""
  echo "  --schedule   New OnCalendar expression"
  echo "  --prompt     New prompt text for pi -p"
  echo "  --pi-flags   New extra flags for pi (replaces all previous flags)"
  exit 1
}

[[ $# -lt 2 ]] && usage

NAME="$1"; shift
UNIT_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="pi-cron-${NAME}"
SERVICE_FILE="${UNIT_DIR}/${SERVICE_NAME}.service"
TIMER_FILE="${UNIT_DIR}/${SERVICE_NAME}.timer"

if [[ ! -f "$TIMER_FILE" ]]; then
  echo "Error: no job found with name '${NAME}'."
  exit 1
fi

NEW_SCHEDULE=""
NEW_PROMPT=""
NEW_PI_FLAGS=""
HAS_PI_FLAGS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --schedule) NEW_SCHEDULE="$2"; shift 2 ;;
    --prompt) NEW_PROMPT="$2"; shift 2 ;;
    --pi-flags) NEW_PI_FLAGS="$2"; HAS_PI_FLAGS=true; shift 2 ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# Update timer if schedule changed
if [[ -n "$NEW_SCHEDULE" ]]; then
  cat > "$TIMER_FILE" <<EOF
[Unit]
Description=pi-cron timer: ${NAME}

[Timer]
OnCalendar=${NEW_SCHEDULE}
Persistent=true

[Install]
WantedBy=timers.target
EOF
  echo "Updated schedule to: ${NEW_SCHEDULE}"
fi

# Update service if prompt or flags changed
if [[ -n "$NEW_PROMPT" ]] || [[ "$HAS_PI_FLAGS" == "true" ]]; then
  # Read current values from metadata comments if we need them
  if [[ -z "$NEW_PROMPT" ]]; then
    NEW_PROMPT=$(grep '^# PI_CRON_PROMPT=' "$SERVICE_FILE" | sed 's/^# PI_CRON_PROMPT=//' || echo "")
  fi
  if [[ "$HAS_PI_FLAGS" != "true" ]]; then
    NEW_PI_FLAGS=$(grep '^# PI_CRON_PI_FLAGS=' "$SERVICE_FILE" | sed 's/^# PI_CRON_PI_FLAGS=//' || echo "")
  fi

  PI_BIN=$(command -v pi 2>/dev/null || echo "pi")

  RUN_DIR="$HOME/.config/pi-cron"
  mkdir -p "$RUN_DIR"
  RUN_SCRIPT="${RUN_DIR}/${NAME}.sh"

  # Capture current DBUS/XDG for keyring access (needed by gog, etc.)
  DBUS_ADDR="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
  XDG_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

  cat > "$RUN_SCRIPT" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
export HOME="${HOME}"
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_ADDR}"
export XDG_RUNTIME_DIR="${XDG_DIR}"
[[ -f "${HOME}/.config/pi-cron/env" ]] && set -a && source "${HOME}/.config/pi-cron/env" && set +a
cd "${HOME}"
${PI_BIN} -p --session-dir ${HOME}/.config/pi-cron/sessions ${NEW_PI_FLAGS} $(printf '%q' "$NEW_PROMPT")
SCRIPT
  chmod +x "$RUN_SCRIPT"

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=pi-cron: ${NAME}

[Service]
Type=oneshot
ExecStart=${RUN_SCRIPT}
WorkingDirectory=${HOME}
StandardOutput=journal
StandardError=journal

# pi-cron metadata (used by edit.sh)
# PI_CRON_PROMPT=${NEW_PROMPT}
# PI_CRON_PI_FLAGS=${NEW_PI_FLAGS}
EOF
  echo "Updated service prompt/flags."
fi

# Reload and restart timer
systemctl --user daemon-reload
systemctl --user reenable "${SERVICE_NAME}.timer" 2>/dev/null || true
systemctl --user restart "${SERVICE_NAME}.timer"

echo "✅ Job '${NAME}' updated."
systemctl --user list-timers "${SERVICE_NAME}.timer"
