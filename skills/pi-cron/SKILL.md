---
name: pi-cron
description: Schedule recurring or one-shot tasks that run pi in non-interactive mode using systemd user timers. Use when the user wants to schedule, list, edit, or remove cron-like jobs handled by pi. No sudo required.
---

# pi-cron

Schedule tasks as systemd user timers that invoke `pi --print` (non-interactive mode). Jobs persist across reboots and run even when the user is not logged in (via lingering).

## Prerequisites

Before creating any jobs, ensure lingering is enabled so timers fire when the user is logged out:

```bash
loginctl enable-linger $(whoami)
```

Verify with:

```bash
loginctl show-user $(whoami) | grep Linger
# Should show: Linger=yes
```

## How It Works

Each scheduled job creates two systemd user unit files:

- `~/.config/systemd/user/pi-cron-<name>.service` — defines what to run
- `~/.config/systemd/user/pi-cron-<name>.timer` — defines when to run it

The service runs `pi -p "<prompt>"` with any additional flags (model, skills, etc). Output is captured in the systemd journal.

## Helper Scripts

All scripts are in the `scripts/` directory relative to this skill file.

### Create a job

```bash
./scripts/add.sh <name> <schedule> <prompt> [extra-pi-flags...]
```

- `<name>`: lowercase alphanumeric + hyphens (e.g. `morning-brief`, `inbox-check`)
- `<schedule>`: systemd OnCalendar expression (e.g. `*-*-* 07:00:00`, `hourly`, `Mon *-*-* 09:00`)
- `<prompt>`: the prompt text pi will execute
- `[extra-pi-flags]`: optional flags passed to pi (e.g. `--skill /path/to/skill --model anthropic/claude-sonnet-4`)

Examples:

```bash
# Daily 7am inbox summary
./scripts/add.sh inbox-summary "*-*-* 07:00:00" "Summarize my gmail inbox from today using gog" --skill ~/kfrance-pi-pack/skills/ynab-api

# Every Monday at 9am
./scripts/add.sh weekly-review "Mon *-*-* 09:00:00" "Give me a weekly review of my Linear issues" --skill ~/kfrance-pi-pack/skills/linear-cli

# Every 15 minutes
./scripts/add.sh quick-check "*:0/15" "Check for urgent emails and alert me"

# One-shot (use a full timestamp)
./scripts/add.sh reminder-tomorrow "2026-04-04 16:00:00" "Remind me to call the dentist"
```

You can test calendar expressions with:

```bash
systemd-analyze calendar "Mon *-*-* 09:00:00"
```

### List jobs

```bash
./scripts/list.sh
```

Shows all `pi-cron-*` timers with next fire time, last run, and enabled status.

### View logs for a job

```bash
./scripts/logs.sh <name> [--lines 50]
```

### Run a job manually (for testing)

```bash
./scripts/run.sh <name>
```

Runs the service immediately without waiting for the timer.

### Edit a job

```bash
./scripts/edit.sh <name> [--schedule <new-schedule>] [--prompt <new-prompt>] [--pi-flags <flags>]
```

### Remove a job

```bash
./scripts/remove.sh <name>
```

Stops, disables, and deletes both the timer and service unit files.

### Status of a specific job

```bash
./scripts/status.sh <name>
```

## Constructing Jobs

When the user asks to schedule something, follow this process:

1. **Determine the schedule**: translate the user's intent into an `OnCalendar` expression. Use `systemd-analyze calendar` to verify.
2. **Craft the prompt**: write a clear, self-contained prompt for `pi -p`. The prompt should include everything pi needs to complete the task since it runs non-interactively with no conversation history.
3. **Identify skills**: if the task involves gmail, ynab, linear, etc., add the relevant `--skill` flag.
4. **Choose a name**: short, descriptive, lowercase with hyphens.
5. **Create the job**: run `./scripts/add.sh` with the above.
6. **Verify**: run `./scripts/list.sh` to confirm the timer is active and `systemd-analyze calendar` to confirm the next fire time makes sense.

## Modifying Jobs

When the user wants to change an existing job:

1. **List jobs first**: run `./scripts/list.sh` to show available jobs and confirm the name.
2. **Edit the job**: use `./scripts/edit.sh <name>` with the flags for what changed (`--schedule`, `--prompt`, `--pi-flags`). Only the specified fields are updated; others remain unchanged.
3. **Verify**: run `./scripts/status.sh <name>` and `./scripts/logs.sh <name>` to confirm the change took effect.

If the change is complex (e.g. renaming), remove the old job and create a new one.

## Removing Jobs

When the user wants to stop or delete a scheduled job:

1. **List jobs first**: run `./scripts/list.sh` to confirm the job name.
2. **Confirm with the user** before removing, especially for recurring jobs.
3. **Remove**: run `./scripts/remove.sh <name>`. This stops and disables the timer, then deletes both unit files.
4. **Verify**: run `./scripts/list.sh` to confirm it's gone.

## Environment Variables

An optional env file at `~/.config/pi-cron/env` is sourced by all run scripts before invoking pi. Use this for shared secrets like webhook URLs, API keys, etc:

```bash
# ~/.config/pi-cron/env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Pi can access these via bash (e.g. `curl -s -X POST "$SLACK_WEBHOOK_URL" ...`).

In prompts, tell pi: "The Slack webhook URL is available in the `SLACK_WEBHOOK_URL` environment variable."

## Output and Delivery

By default, job output goes to the systemd journal only. To have output delivered somewhere:

- **Slack**: tell pi to use `$SLACK_WEBHOOK_URL` from the env file
- **File output**: include instructions in the prompt like "write the summary to ~/reports/daily-summary.md"
- **Email**: include instructions like "send the summary via gog gmail send"
- **Notification**: the prompt can invoke any CLI tool available to pi

## Timezone

Timers use the system's local timezone by default. The user's timezone can be checked with:

```bash
timedatectl show --property=Timezone --value
```

## Troubleshooting

```bash
# Check if lingering is enabled
loginctl show-user $(whoami) | grep Linger

# Check if the timer is loaded and active
systemctl --user status pi-cron-<name>.timer

# Check if the service ran and its exit status
systemctl --user status pi-cron-<name>.service

# View full logs
journalctl --user -u pi-cron-<name>.service --no-pager -n 100

# List all pi-cron timers
systemctl --user list-timers 'pi-cron-*'

# Reload after manual edits to unit files
systemctl --user daemon-reload
```
