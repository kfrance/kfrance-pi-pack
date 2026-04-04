#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <name> [--lines N]"
  echo "  Show journal logs for a pi-cron job."
  exit 1
}

[[ $# -lt 1 ]] && usage

NAME="$1"; shift
LINES=50

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lines) LINES="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

SERVICE_NAME="pi-cron-${NAME}"

journalctl --user -u "${SERVICE_NAME}.service" --no-pager -n "$LINES"
