#!/usr/bin/env bash
set -euo pipefail

echo "=== pi-cron jobs ==="
echo ""

# List all pi-cron timers
TIMERS=$(systemctl --user list-timers 'pi-cron-*' --no-pager 2>/dev/null || true)

if [[ -z "$TIMERS" ]] || echo "$TIMERS" | grep -q "^0 timers"; then
  echo "No pi-cron jobs found."
  exit 0
fi

echo "$TIMERS"
echo ""

# Also show any disabled pi-cron timers
DISABLED=$(systemctl --user list-unit-files 'pi-cron-*.timer' --no-pager 2>/dev/null | grep -v "^$" | grep -v "^UNIT" | grep -v "listed" || true)
if [[ -n "$DISABLED" ]]; then
  echo "=== All pi-cron timer states ==="
  echo "$DISABLED"
fi
