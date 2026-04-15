---
description: Run a multi-model council workflow using the council skill
---
Load and follow the `council` skill for this request: $@

If this request depends on the current conversation, first create a council brief file that captures the relevant context, constraints, and desired outcome.

Prefer a repo-local temporary council workspace such as `.tmp/council/<slug>/` for the brief and run artifacts when available, while keeping the final deliverable wherever the task requires.

Then run the council workflow using that brief.

After the council run completes, read the generated summary and chairman report, then give me:
- the run directory
- the chairman report path
- the key corrections made during the council
- a participant-by-participant contribution breakdown
- a participant ranking with rationale
- any important disagreements that remain
