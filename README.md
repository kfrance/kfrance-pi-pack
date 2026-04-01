# kfrance-pi-pack

Personal [pi](https://github.com/badlogic/pi-mono) extensions, skills, and prompt templates.

## Installation

```bash
pi install git:github.com/kfrance/kfrance-pi-pack
```

## Extensions

### subagent

Vendored local subagent runtime based on `pi-subagents`, adapted for this package **without shipping any builtin agents**.

**What it provides:**
- `subagent` tool for single, parallel, and chain delegation
- `subagent_status` tool for checking background jobs
- slash commands such as `/run`, `/chain`, `/parallel`, and `/agents`
- async/background execution, notifications, and the agent manager UI

**Agent discovery:**
- user agents from `~/.pi/agent/agents/`
- project agents from the nearest `.pi/agents/`

No ambient builtin agents like `scout`, `planner`, or `researcher` are included. If you want an agent, define it explicitly in user or project scope.

### git-gh-write-gate

Requires user confirmation before executing destructive git or GitHub commands. Read-only commands pass through freely.

**Gated commands:**
- **GitHub writes:** `gh api -X POST/PUT/PATCH/DELETE`, `gh pr create/merge/comment`, `gh issue create/comment`, etc.
- **Git state changes:** `add`, `commit`, `push`, `rebase`, `reset`, `merge`, `cherry-pick`, `revert`, `stash`, `clean`, `restore`, branch/tag deletion, force push

**Allowed freely:**
- `git status`, `git log`, `git diff`, `git show`, `git fetch`, `git branch` (list), `git checkout` (branch switch)
- `gh pr view/list`, `gh issue list`, `gh api` (GET)

### compact-and-continue

Registers a `compact_and_continue` tool that compacts the current conversation immediately, then queues a fresh user turn to resume work automatically.

**Behavior:**
- Optionally accepts `instructions` to bias the compaction summary
- Prevents overlapping compaction runs in the same session
- Notifies the user when compaction starts, finishes, or fails
- After completion, sends a resume prompt telling pi to continue from the compacted summary and current todo state

## Skills

### linear-cli

Manage Linear issues from the command line using the `linear` CLI. Requires the [`linear` CLI](https://github.com/schpet/linear-cli) to be installed and authenticated.

Covers issue management, team/project queries, and direct GraphQL API access as a fallback for advanced queries.

## Development

```bash
npm install
npm test
```

## License

MIT
