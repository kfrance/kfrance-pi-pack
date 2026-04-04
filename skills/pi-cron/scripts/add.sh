#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <name> <schedule> <prompt> [extra-pi-flags...]"
  echo ""
  echo "  name       Job name (lowercase, alphanumeric, hyphens)"
  echo "  schedule   OnCalendar expression (e.g. '*-*-* 07:00:00', 'hourly')"
  echo "  prompt     Prompt text for pi -p"
  echo "  flags      Extra flags passed to pi (e.g. --skill /path --model name)"
  echo ""
  echo "Examples:"
  echo "  $0 inbox-summary '*-*-* 07:00:00' 'Summarize my gmail inbox'"
  echo "  $0 weekly-review 'Mon *-*-* 09:00:00' 'Review Linear issues' --skill ~/skills/linear-cli"
  exit 1
}

[[ $# -lt 3 ]] && usage

NAME="$1"; shift
SCHEDULE="$1"; shift
PROMPT="$1"; shift
PI_FLAGS="${*:-}"

# Validate name
if [[ ! "$NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "Error: name must be lowercase alphanumeric with hyphens, no leading/trailing hyphens."
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="pi-cron-${NAME}"
SERVICE_FILE="${UNIT_DIR}/${SERVICE_NAME}.service"
TIMER_FILE="${UNIT_DIR}/${SERVICE_NAME}.timer"

# Check for existing job
if [[ -f "$TIMER_FILE" ]]; then
  echo "Error: job '${NAME}' already exists. Use edit.sh to modify or remove.sh to delete first."
  exit 1
fi

mkdir -p "$UNIT_DIR"

# Find pi binary
PI_BIN=$(command -v pi 2>/dev/null || echo "pi")

# Create a run script so we avoid systemd escaping issues
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
${PI_BIN} -p --session-dir ${HOME}/.config/pi-cron/sessions ${PI_FLAGS} $(printf '%q' "$PROMPT")
SCRIPT
chmod +x "$RUN_SCRIPT"

# Write service unit
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
# PI_CRON_PROMPT=${PROMPT}
# PI_CRON_PI_FLAGS=${PI_FLAGS}
EOF

# Write timer unit
cat > "$TIMER_FILE" <<EOF
[Unit]
Description=pi-cron timer: ${NAME}

[Timer]
OnCalendar=${SCHEDULE}
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Reload and enable
systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_NAME}.timer"

echo "✅ Created and enabled job '${NAME}'"
echo "   Service: ${SERVICE_FILE}"
echo "   Timer:   ${TIMER_FILE}"
echo ""
systemctl --user list-timers "${SERVICE_NAME}.timer"
