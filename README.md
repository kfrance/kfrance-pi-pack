# kfrance-pi-pack

Personal [pi](https://github.com/badlogic/pi-mono) extensions, skills, and prompt templates.

## Installation

```bash
pi install git:github.com/kfrance/kfrance-pi-pack
```

## Extensions

### plan

Structured planning workflow with two modes. Requires the [subagent extension](https://github.com/badlogic/pi-mono) (global).

**Usage:**
```
/plan <idea text or path>           # defaults to heavy
/plan heavy <idea text or path>     # full ceremony
/plan light <idea text or path>     # lightweight, no file saved
```

**Both modes:**
1. Codebase exploration
2. 3–5 independent assumptions for confirmation
3. Clarifying questions one at a time
4. Test discovery via subagent
5. Plan drafting with review

**Heavy mode** runs test-discovery → then test-reviewer + maintainability-reviewer in parallel (3 subagent calls). Saves plan to `.plan/<plan_id>.md` with YAML frontmatter and git backup.

**Light mode** runs test-discovery → then a single combined-reviewer (2 subagent calls). Produces a concise plan in chat with no file saved.

### Bundled Agents

The plan extension ships with four agents that are symlinked into `~/.pi/agent/agents/` on load, making them available for any extension or direct subagent invocation:

| Agent | Purpose |
|-------|---------|
| `test-discovery` | Analyzes existing test landscape for proposed changes |
| `test-reviewer` | Reviews plan's test coverage, flags anti-cheat patterns |
| `maintainability-reviewer` | Reviews plan for long-term maintenance concerns |
| `combined-reviewer` | Single-pass review covering both test and maintenance (light mode) |

All agents use `claude-sonnet-4-6`.

### git-gh-write-gate

Requires user confirmation before executing destructive git or GitHub commands. Read-only commands pass through freely.

**Gated commands:**
- **GitHub writes:** `gh api -X POST/PUT/PATCH/DELETE`, `gh pr create/merge/comment`, `gh issue create/comment`, etc.
- **Git state changes:** `add`, `commit`, `push`, `rebase`, `reset`, `merge`, `cherry-pick`, `revert`, `stash`, `clean`, `restore`, branch/tag deletion, force push

**Allowed freely:**
- `git status`, `git log`, `git diff`, `git show`, `git fetch`, `git branch` (list), `git checkout` (branch switch)
- `gh pr view/list`, `gh issue list`, `gh api` (GET)

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
