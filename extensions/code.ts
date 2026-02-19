/**
 * Code Command Extension
 *
 * Implements a /code command that takes a plan file and sends an implementation
 * prompt to the agent. Tracks plan status via YAML frontmatter:
 *
 *   draft → coding → ai-attempted
 *
 * The agent_end hook sets status to "ai-attempted" when the agent finishes.
 * This fires regardless of completion quality — it means "the AI took a pass,"
 * not "the work is complete." The implementation prompt asks the agent to
 * summarize its completion status before finishing.
 *
 * Usage:
 *   /code <plan-id>         Look up <plan-id>.md in the plan output directory
 *   /code path/to/plan.md   Use a direct file path
 *
 * Plan output directory resolution (shared with plan.ts):
 *   1. plan.outputDir in .pi/settings.json
 *   2. .plan/ (default)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { resolveOutputDir, DEFAULT_OUTPUT_DIR } from "../lib/plan-utils.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CodeState {
  active: boolean;
  planPath: string;
  planId: string;
}

const INITIAL_STATE: CodeState = {
  active: false,
  planPath: "",
  planId: "",
};

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter status from a plan file's content.
 * Returns the status string or null if not found / malformed.
 */
export function parseFrontmatterStatus(content: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const statusMatch = fmMatch[1].match(/^status:\s*["']?(\w[\w-]*)["']?\s*$/m);
  return statusMatch ? statusMatch[1] : null;
}

/**
 * Update the status field in a plan file's YAML frontmatter.
 *
 * Handles unquoted, single-quoted, and double-quoted status values.
 * Preserves all other frontmatter fields and body content exactly.
 *
 * Throws if:
 *   - Content has no valid frontmatter (no --- delimiters)
 *   - Frontmatter has no status key
 */
export function updateFrontmatterStatus(content: string, newStatus: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    throw new Error("No valid YAML frontmatter found");
  }

  const frontmatter = fmMatch[2];
  const statusPattern = /^(status:\s*)["']?[\w-]*["']?(\s*)$/m;
  const statusMatch = frontmatter.match(statusPattern);

  if (!statusMatch) {
    throw new Error("No status field found in frontmatter");
  }

  const updatedFrontmatter = frontmatter.replace(
    statusPattern,
    `$1${newStatus}$2`,
  );

  return fmMatch[1] + updatedFrontmatter + fmMatch[3] + content.slice(fmMatch[0].length);
}

/**
 * Read a plan file, update its frontmatter status, and write it back.
 * Throws if the file doesn't exist, has no frontmatter, or has no status key.
 */
export function updatePlanFileStatus(filePath: string, newStatus: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Plan file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const updated = updateFrontmatterStatus(content, newStatus);
  fs.writeFileSync(filePath, updated, "utf-8");
}

// ---------------------------------------------------------------------------
// Plan ID scanning and path resolution
// ---------------------------------------------------------------------------

/**
 * Scan an output directory for plan .md files with status: draft.
 * Returns matching plan IDs filtered by prefix, or null if none found.
 */
export function getDraftPlanIds(
  outputDir: string,
  cwd: string,
  prefix: string = "",
): AutocompleteItem[] | null {
  const resolvedDir = path.resolve(cwd, outputDir);

  if (!fs.existsSync(resolvedDir)) return null;

  let files: string[];
  try {
    files = fs.readdirSync(resolvedDir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  const items: AutocompleteItem[] = [];

  for (const file of files) {
    const planId = file.replace(/\.md$/, "");
    if (!planId.startsWith(prefix)) continue;

    try {
      const content = fs.readFileSync(path.join(resolvedDir, file), "utf-8");
      const status = parseFrontmatterStatus(content);
      if (status === "draft") {
        items.push({ value: planId, label: `${planId} (draft)` });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return items.length > 0 ? items : null;
}

/**
 * Resolve a plan ID or path to an absolute file path.
 *
 * - Input containing "/" or ending with ".md" → treat as a file path
 * - Otherwise → resolve as <outputDir>/<planId>.md
 */
export function resolvePlanPath(
  input: string,
  outputDir: string,
  cwd: string,
): string {
  if (input.includes("/") || input.endsWith(".md")) {
    return path.resolve(cwd, input);
  }
  return path.resolve(cwd, outputDir, `${input}.md`);
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildImplementationPrompt(planPath: string): string {
  return `# Implementation Task

You have a plan to implement. Follow it end-to-end.

## Your Plan

The plan is at \`${planPath}\`. Read it with the Read tool to get started.

## Implementation Phase

1. Run \`pwd\` to get your working directory path.
2. Read the plan file and all referenced files to understand the full scope.
3. Look for project guidance files like \`CLAUDE.md\`, \`AGENTS.md\`, \`CONTRIBUTING.md\`, \`README.md\`.
4. Gather additional context (repo structure, relevant source files) as needed.
5. Implement all changes required by the plan, following project conventions.

## Review Loop (repeat until clean)

After implementing, run the review loop:

1. **Lint**: Run the project's linter if one is configured (check package.json scripts, pyproject.toml, Makefile, etc.).
2. **Tests**: Run the project's test suite. Fix any failures before continuing.
3. **Subagent Reviews**: Invoke both subagents in parallel:
   - \`code-review-auditor\` — reviews code quality and correctness
   - \`plan-alignment-checker\` — verifies all plan items are implemented
4. **Display Reports**: Show the full subagent reports verbatim under headings:
   - \`## Code Review Auditor Report\`
   - \`## Plan Alignment Checker Report\`
5. **Fix Issues**: Address any HIGH or MEDIUM severity issues found. LOW issues do not need to be fixed.
6. **Repeat**: If you made fixes, run tests and reviews again.
7. **Done**: Stop only when tests pass AND both reviews report no HIGH or MEDIUM issues.

## Detecting the Test Command

Look for these indicators to find the right test command:
- \`package.json\` → \`npm test\` or scripts like \`test\`, \`test:unit\`
- \`pyproject.toml\` with pytest → \`uv run pytest\` or \`pytest\`
- \`Cargo.toml\` → \`cargo test\`
- \`Makefile\` / \`justfile\` → \`make test\` or \`just test\`
- \`go.mod\` → \`go test ./...\`
- \`CLAUDE.md\` or \`AGENTS.md\` often documents the test command

## Operating Principles

- Always perform real tool invocations, never describe hypothetical commands.
- Keep a clear record of actions taken.
- Preserve subagent independence: they gather their own context.
- Focus only on what the plan requires — do not add features outside scope.

## Completion Summary

Before you finish, provide a clear summary of:
- What was implemented
- What was NOT implemented (if anything)
- Test results
- Subagent review results

This summary is the audit trail for the plan's status update.`;
}

export function buildSystemPromptAddendum(planPath: string): string {
  return `## Active Code Session

You are in an active /code session implementing a plan. Key rules:
- You MUST run tests and invoke the code-review-auditor and plan-alignment-checker subagents before finishing.
- The plan is at ${planPath}.
- Before finishing, provide a completion summary covering what was and wasn't implemented.`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let state: CodeState = { ...INITIAL_STATE };

  // Restore state on session restart
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "code-state") {
        state = entry.data as CodeState;
      }
    }
    if (state.active) {
      ctx.ui.setStatus(
        "code",
        `🔧 Plan: ${state.planId}`,
      );
      ctx.ui.notify(
        `Restored active /code session for "${state.planId}". Send a message to resume implementation.`,
        "info",
      );
    }
  });

  // Inject system prompt addendum when code session is active
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!state.active) return;

    return {
      systemPrompt:
        event.systemPrompt + "\n\n" + buildSystemPromptAddendum(state.planPath),
    };
  });

  // Single-shot: mark plan as ai-attempted when agent finishes
  pi.on("agent_end", async (_event, ctx) => {
    if (!state.active) return;

    try {
      updatePlanFileStatus(state.planPath, "ai-attempted");
      ctx.ui.notify(
        `Plan "${state.planId}" status updated to ai-attempted.`,
        "info",
      );
    } catch (err: any) {
      ctx.ui.notify(
        `Failed to update plan status: ${err.message}`,
        "warning",
      );
    }

    state.active = false;
    ctx.ui.setStatus("code", undefined);
    pi.appendEntry("code-state", state);
  });

  // /code command
  pi.registerCommand("code", {
    description:
      "Implement a plan file. Usage: /code <plan-id-or-path>",
    getArgumentCompletions: (
      prefix: string,
      ctx?: any,
    ): AutocompleteItem[] | null => {
      const cwd = ctx?.cwd || process.cwd();
      const outputDir = resolveOutputDir(null, cwd);
      return getDraftPlanIds(outputDir, cwd, prefix);
    },
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify(
          "Usage: /code <plan-id-or-path>\n\nExamples:\n  /code my-feature        Look up .plan/my-feature.md\n  /code path/to/plan.md   Use a direct file path",
          "error",
        );
        return;
      }

      const input = args.trim();
      const outputDir = resolveOutputDir(null, ctx.cwd);
      const planPath = resolvePlanPath(input, outputDir, ctx.cwd);

      if (!fs.existsSync(planPath)) {
        ctx.ui.notify(`Plan file not found: ${planPath}`, "error");
        return;
      }

      // Verify draft status
      const content = fs.readFileSync(planPath, "utf-8");
      const status = parseFrontmatterStatus(content);
      if (status !== "draft") {
        ctx.ui.notify(
          `Plan is not in draft status (current: ${status ?? "unknown"}). Only draft plans can be started with /code.`,
          "error",
        );
        return;
      }

      // Update to coding
      try {
        updatePlanFileStatus(planPath, "coding");
      } catch (err: any) {
        ctx.ui.notify(
          `Failed to update plan status: ${err.message}`,
          "error",
        );
        return;
      }

      // Derive plan ID from filename
      const planId = path.basename(planPath, ".md");

      // Set state
      state = {
        active: true,
        planPath,
        planId,
      };
      pi.appendEntry("code-state", state);
      ctx.ui.setStatus("code", `🔧 Plan: ${planId}`);
      ctx.ui.notify(`Starting code session for "${planId}"...`, "info");

      // Send implementation prompt
      const prompt = buildImplementationPrompt(planPath);
      pi.sendUserMessage(prompt);
    },
  });

  // /code-status command
  pi.registerCommand("code-status", {
    description: "Show current code command status",
    handler: async (_args, ctx) => {
      if (!state.active) {
        ctx.ui.notify("No active code session.", "info");
        return;
      }
      ctx.ui.notify(
        `Plan: ${state.planId}\nPath: ${state.planPath}`,
        "info",
      );
    },
  });
}
