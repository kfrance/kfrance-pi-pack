# subagent (vendored)

This extension is vendored from `/tmp/pi-subagents` for use inside `kfrance-pi-pack`.

Important local policy:
- **No builtin agents are shipped.**
- Do not add an `agents/` directory here unless you intentionally want ambient builtin agents to become discoverable again.
- Agents should come from `~/.pi/agent/agents/` or the nearest project `.pi/agents/` directory.

The nested `package.json` registers both `index.ts` and `notify.ts` so the tool runtime and completion notifications are both loaded by pi.
