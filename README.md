# kfrance-pi-pack

Personal [pi](https://github.com/badlogic/pi-mono) extensions, skills, and prompt templates.

## Installation

```bash
pi install git:github.com/kfrance/kfrance-pi-pack
```

## Extensions

### sandbox

Runs the `bash` tool (and `!` commands) inside bubblewrap through
`@anthropic-ai/sandbox-runtime`, and checks `read`, `edit` and `write` paths
against the same rules. The filesystem is read-only except `allowWrite`
(default: the working folder and `/tmp`); network access is unrestricted.

- Unix sockets are allowed (`allowAllUnixSockets`), so tools like tsx work.
  The sockets that would let a command escape are hidden by default:
  `/run/user/<uid>` (systemd user bus, ssh and gpg agents) and the Docker socket.
- `PI_SANDBOX=required` turns the sandbox on regardless of `sandbox.json` and
  fails closed: if bubblewrap cannot start, `bash`, `edit` and `write` refuse.
  `PI_SANDBOX=off` keeps it off. Unset, `~/.pi/agent/sandbox.json` and
  `<cwd>/.pi/sandbox.json` decide.
- When a sandboxed command fails because a write was denied, the extension asks
  `ctx.ui.confirm("Run outside the sandbox?", <command>)`. Yes reruns that
  command once without the sandbox; no returns the failure plus a line saying
  the owner declined.
- Commands: `/sandbox`, `/sandbox-on`, `/sandbox-off`, `/sandbox-add <path>`,
  `/sandbox-deny <path>`. Flag: `--no-sandbox`.
- Requires `bwrap`, `rg` and `socat`.

### ant-auth

Lets pi's built-in `anthropic` provider sign in with the official Anthropic CLI
(`ant auth login`) instead of an API key. Anthropic models show as available;
each request gets a token from `ant auth print-credentials`, sent as
`Authorization: Bearer` with the `oauth-2025-04-20` beta. A stored API key in
`auth.json` or an `ANTHROPIC_*` variable still wins. The token stays in memory
only. If `ant` is missing or signed out, requests fail with
"Claude needs the ant sign-in. Run: ant auth login".

`ant` is found as `PI_ANT_BIN`, then on `PATH`, then `~/.local/bin/ant`;
`ANTHROPIC_PROFILE` picks the profile.

## Skills

- `flightclaw` — flight search and price tracking scripts
- `ynab-api` — YNAB API reference

## Development

```bash
npm install
npm test
```

## License

MIT
