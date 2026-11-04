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

### command-gate

Requires user confirmation before executing gated commands, and attempts to log every `bash` command it sees for later inspection.

**Gated commands:**
- **Any `gog` usage**
- **Selected GitHub writes:** `gh api -X POST/PUT/PATCH/DELETE`, `gh api` requests that imply `POST` via `-f` / `--field` / `--input` unless `GET` is explicit, `gh pr create/merge/comment`, `gh issue create/comment`, etc.
- **Selected git state changes:** `add`, `commit`, `push`, `rebase`, `reset`, `merge`, `cherry-pick`, `revert`, `stash`, `clean`, `restore`, branch/tag deletion, force push

**Allowed freely:**
- `git status`, `git log`, `git diff`, `git show`, `git fetch`, `git branch` (list), `git checkout` (branch switch)
- `gh pr view/list`, `gh issue list`, `gh api` (GET)

**Command logging:**
- Writes JSONL logs to `$XDG_STATE_HOME/kfrance-pi-pack/command-gate/` when `XDG_STATE_HOME` is set
- Otherwise writes to `~/.local/state/kfrance-pi-pack/command-gate/`
- Active log file: `command-gate.jsonl`
- Rotates when the next write would push the file over 50 MiB
- Keeps unlimited numbered archives like `command-gate.jsonl.1`, `command-gate.jsonl.2`, etc.
- Uses a lock file to serialize rotation/appends across concurrent pi sessions
- Automatically reclaims stale lock files older than 30 seconds
- Logging is best-effort: if a log write fails, the extension warns and continues with its normal gating decision

**Safety bias:**
- Matching is intentionally conservative. Mentions of gated commands inside larger shell strings can still be gated for safety (for example inside `echo`, `grep`, comments, or compound shell commands).

### compact-and-continue

Registers a `compact_and_continue` tool that compacts the current conversation immediately, then queues a fresh user turn to resume work automatically.

**Behavior:**
- Optionally accepts `instructions` to bias the compaction summary
- Prevents overlapping compaction runs in the same session
- Notifies the user when compaction starts, finishes, or fails
- After completion, sends a resume prompt telling pi to continue from the compacted summary and current todo state

## Skills

### council

Run a multi-model council workflow where several models independently draft, critique, and revise an artifact before a fresh chairman synthesizes the final result.

What it provides:
- a `council` skill for orchestrating multi-model deliberation through normal `pi -p` runs
- a `/council` prompt-template alias for ergonomic invocation
- persistent per-participant pi sessions across rounds
- a fresh chairman pass using `pi-cc-router/claude-opus-4-6` by default
- Opus is intentionally routed through `pi-cc-router`, not OpenRouter
- council runs can be directed to any explicit workspace path, and a repo-local temp area such as `.tmp/council/<slug>/` is a good default when available

Typical command flow:
- `/council ...` to load the skill
- then `npx tsx ./skills/council/scripts/run-council.ts --brief <path>` to execute a run

Typical flow:
1. Choose a council workspace, preferably a repo-local temp path such as `.tmp/council/<slug>/`
2. Create a council brief from the current conversation or a standalone task inside that workspace
3. Run `npx tsx ./skills/council/scripts/run-council.ts --brief <path> --run-dir <workspace>`
4. Read `summary.md` and `chairman/chairman-report.md` for the final artifact, key corrections, participant contribution breakdown, and participant ranking

Notes:
- relative `--run-dir` values resolve from `--cwd`
- a repo-local temp workspace such as `.tmp/council/<slug>/` is a good place for briefs and council artifacts when available
- keep final deliverables separate from the council workspace when the task wants the final artifact elsewhere
- reusing `--run-dir` resets prior generated council outputs for a fresh rerun
- default `pi` resolution prefers a non-`node_modules/.bin` binary on PATH
- council subprocesses explicitly enable built-in tools including `bash`, `grep`, `find`, and `ls`
- participant runs execute concurrently within each council stage
- the chairman report now includes a participant-by-participant contribution breakdown and a ranked assessment of council members for that run
- missing expected files can be retried with `--max-retries <n>`

## Development

```bash
npm install
npm test
```

## License

MIT
