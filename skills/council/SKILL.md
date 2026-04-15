---
name: council
description: Build an artifact through a multi-model council process. Use when the user wants several models to independently produce, critique, and revise artifacts before a fresh chairman synthesizes the final result.
---

# Council

Use a multi-model council to improve an artifact through independent drafts, cross-critique, revision, and final chairman synthesis.

## When to Use It

Use this skill when the user wants:

- a plan reviewed and improved by multiple models
- a code review with diverse viewpoints
- a stronger design or implementation proposal that benefits from peer critique
- the current conversation turned into a council brief and debated by several models

## User-Facing Command

This skill is intended to be used through the `/council` prompt template alias.

The underlying skill command is:

```bash
/skill:council
```

## Core Design

The council workflow is **skill-first** and uses normal `pi -p` subprocesses.

Important behaviors:

- each participant keeps its own **persistent pi session** across rounds
- the **chairman is always fresh**
- the helper script handles orchestration only
- participant stages are run concurrently within each stage group, while stage order remains synchronized
- council subprocesses explicitly run with built-in tools enabled, including `bash`
- participant and chairman prompts are responsible for **writing their own files**
- if the request depends on the current conversation, first create a **council brief** file that captures the necessary context
- **never use Opus via OpenRouter** in this workflow; when Opus is requested or selected, it must resolve to `pi-cc-router/claude-opus-4-6` rather than any `openrouter/anthropic/claude-opus-*` model
- model choice must be based on `pi --list-models` from the **same cwd and environment** that will be used for the actual council subprocesses
- do **not** assume a provider is available just because a model family name is familiar; for example, `gpt-5.4` may be available through `openrouter/openai/gpt-5.4` even when `openai-codex/gpt-5.4` is unavailable

## Default Model Slots

These are the preferred defaults. The runner resolves them against `pi --list-models` before execution.

They are preferences, not guarantees. If the current environment lacks the needed provider/API key, use the exact model IDs that actually appear in `pi --list-models` for that environment or ask the user.

- **A**: `pi-cc-router/claude-opus-4-6`
- **B**: `openai-codex/gpt-5.4`
- **C**: `openrouter/google/gemini-3.1-pro-preview`
- **D**: `openrouter/x-ai/grok-4.20`
- **E**: `openrouter/z-ai/glm-5.1`
- **F**: `openrouter/minimax/minimax-m2.7`

> Cost rule: Opus defaults and aliases in this skill are intentionally pinned to `pi-cc-router`. Do not substitute an OpenRouter Opus variant as a fallback.

Default chairman:

- `pi-cc-router/claude-opus-4-6`

Default participant count:

- `2`

Default critique/revision cycles:

- `2`

## Workflow

### Stage 0: Prepare the council brief

If the user refers to the **current conversation**, first write a brief into a council workspace such as:

```text
.tmp/council/<slug>/input/task.md
```

That brief should capture:

- the actual task the council should solve
- relevant context from the current conversation
- constraints and preferences
- what a good final artifact should contain
- any open tensions or unresolved questions

If the user already gave a clear standalone task, still create a brief file so the participant runs have an explicit shared input.

Prefer to keep council workspace artifacts in a repo-local temporary area such as `.tmp/council/<slug>/` when the repository has a suitable temp directory. Put the final deliverable wherever the task requires; do not assume the final deliverable should live beside the council workspace.

### Stage 1: Initial artifact

Each participant reads the brief and writes its own first artifact.

### Stage 2: Analysis

Each participant reads the other participants' artifacts and writes an analysis.

The analysis should explicitly include visible sections such as:

- approach to analysis
- strongest ideas from peers
- weaknesses or blind spots
- where peers may be wrong or incomplete
- what feedback should change the participant's own artifact

### Stage 3: Revision

Each participant revises its own artifact and writes revision notes.

Revision notes should list:

- key changes made
- feedback accepted
- feedback rejected and why

### Repeat

Run the configured number of analysis/revision cycles.

### Chairman

A **fresh** chairman session reads the final artifacts, analyses, and revision notes, then writes a chairman report with these top-level sections:

- `# Final Artifact`
- `# Key Corrections Made During Council`
- `# Participant Contribution Breakdown`
- `# Participant Ranking`
- `# Important Disagreements or Minority Views`
- `# Open Questions or Residual Risks`

The chairman should explicitly evaluate each participant's contribution on the merits of that specific run, including what they improved, what they missed, and how much they influenced the final artifact.

## Runner Script

The helper script is located here:

```bash
./skills/council/scripts/run-council.ts
```

Run it with `npx tsx`:

```bash
npx tsx ./skills/council/scripts/run-council.ts --brief <path>
```

Useful options:

```bash
--brief <path>       # Required council brief file
--count <n>          # Number of participants (default: 2)
--rounds <n>         # Critique/revision cycles (default: 2)
--models <csv>       # Optional participant model requests/aliases
--chairman <model>   # Optional chairman model request/alias
--run-dir <path>     # Optional explicit run directory (relative paths resolve from --cwd)
--cwd <path>         # Optional working directory for pi runs
--pi-bin <path>      # Optional pi executable (default: first non-node_modules pi on PATH)
--tools <csv>        # Optional built-in tools for council subprocesses (default: read,bash,edit,write,grep,find,ls)
--timeout-ms <n>     # Optional per-pi-call timeout in ms (default: 1800000)
--max-retries <n>    # Optional retries when expected files are missing (default: 1)
```

Examples:

```bash
npx tsx ./skills/council/scripts/run-council.ts --brief ./skills/council/runs/demo/input/task.md

npx tsx ./skills/council/scripts/run-council.ts \
  --brief ./skills/council/runs/demo/input/task.md \
  --count 3 \
  --rounds 2 \
  --models opus-4.6,gpt-5.4,gemini-3.1-pro-preview
```

## Recommended Operating Procedure

When the user invokes council:

1. Decide whether the task is standalone or conversation-derived.
2. Choose a council workspace directory, preferably a repo-local temp path such as `.tmp/council/<slug>/` when available.
3. Create the council brief file inside that workspace.
4. Inspect `pi --list-models` in the same cwd/environment you will use for the run, then choose exact participant/chairman model IDs from that output.
5. Tell the user what models and rounds you plan to use.
6. Run the council helper script.
7. Read the generated summary and chairman report.
8. Give the user a concise response that includes:
   - path to the run directory
   - path to the chairman report
   - key corrections made during the council
   - participant contribution breakdown
   - participant ranking with rationale

## Important Constraints

- Do **not** assume the subprocess participant runs can see the current conversation automatically.
- Always bridge context through the council brief file.
- Prefer a temp workspace such as `.tmp/council/<slug>/` for council run state, briefs, participant artifacts, and reports when the repo provides such a location.
- Keep the final artifact path separate from the council workspace when the user wants the final output somewhere else.
- Do **not** write participant artifacts yourself unless you are acting as one of the prompted pi subprocesses.
- The helper script should orchestrate the run, but the **prompted pi runs** should create the artifact files.
- Reusing an explicit run directory should be treated as a fresh rerun of generated council outputs; the runner clears prior participant/chairman/control outputs before starting.
- If a requested model is unavailable, inspect `pi --list-models` in the same cwd/environment as the intended run, choose the closest obvious match when safe, or ask the user.
- If you source or depend on repo-local env files before running council, re-run `pi --list-models` after that env is active; available providers can change materially.
- Do not chase a preferred provider name if `pi --list-models` shows the model under a different provider in the active environment. Prefer the exact listed model ID unless the user explicitly requires a specific provider.
- If the desired provider is missing because its API key is absent, say so clearly instead of repeatedly retrying alternate spellings of the same unavailable model.
- For any Opus request, prefer `pi-cc-router/claude-opus-4-6` only. Do not fall back to OpenRouter Opus models for convenience.

## Output Layout

A council run produces a directory like:

```text
skills/council/runs/run-xxxxxx/
  manifest.json
  resolved-models.json
  summary.md
  control/
    prompts/
  input/
    task.md
  participants/
    A/
      session/
      artifact-r1.md
      analysis-r1.md
      artifact-r2.md
      analysis-r2.md
      artifact-final.md
      revision-notes-r1.md
      revision-notes-r2.md
    B/
      ...
  chairman/
    session/
    chairman-report.md
```

## Final Response Pattern

After a successful run, read at least:

- `summary.md`
- `chairman/chairman-report.md`

Then respond with:

- the final artifact location
- the run directory
- the most important corrections made during the council
- a participant-by-participant contribution breakdown
- a participant ranking with concise rationale
- any major disagreements that remained
