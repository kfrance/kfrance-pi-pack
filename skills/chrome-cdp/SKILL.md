---
name: chrome-cdp
description: Interact with a local Chrome-family browser session over the Chrome DevTools Protocol when the user explicitly asks you to inspect, debug, or interact with a page open in their browser.
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI for pi. It connects directly over WebSocket and keeps a background daemon alive so repeated commands can reuse existing target sessions instead of asking for Chrome approval every time.

## Prerequisites

- A Chrome-family browser with remote debugging enabled
- Node.js 22+ (uses built-in `WebSocket`)

To enable remote debugging in Chrome, open:

```text
chrome://inspect/#remote-debugging
```

and toggle the switch on.

## Commands

All commands use `scripts/cdp.mjs`.

Start by listing pages:

```bash
scripts/cdp.mjs list
```

The `<target>` argument is a unique targetId prefix from `list` output.

### Screenshots

```bash
scripts/cdp.mjs shot <target> [file]
```

Default output path: `/tmp/screenshot.png`

### Accessibility snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]
scripts/cdp.mjs nav     <target> <url>
scripts/cdp.mjs net     <target>
scripts/cdp.mjs click   <target> <selector>
scripts/cdp.mjs clickxy <target> <x> <y>
scripts/cdp.mjs type    <target> <text>
scripts/cdp.mjs loadall <target> <selector> [ms]
scripts/cdp.mjs evalraw <target> <method> [json]
scripts/cdp.mjs stop
```

## Approval / persistence behavior

Chrome may show an **Allow debugging** prompt the first time the daemon attaches to a tab. This skill keeps a single background daemon alive and reuses attached sessions for previously accessed tabs, so repeated commands during the daemon lifetime should not keep prompting for approval.

The daemon auto-exits after 20 minutes of inactivity.

## Browser / OS notes

The script is not hardcoded to a single macOS path. It looks for `DevToolsActivePort` in common Chrome-family locations on macOS, Linux, and Windows, and also supports explicit overrides through environment variables such as:

- `CDP_DEVTOOLS_ACTIVE_PORT`
- `CHROME_CDP_DEVTOOLS_ACTIVE_PORT`
- `CHROME_DEVTOOLS_ACTIVE_PORT`

If automatic discovery fails, point one of those variables at the browser's `DevToolsActivePort` file.
