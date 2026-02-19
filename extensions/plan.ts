/**
 * Plan Command Extension
 *
 * Structured planning workflow with two modes:
 *   - heavy (default): Full ceremony with test-discovery, parallel review
 *     subagents (maintainability-reviewer + test-reviewer), and saves plan
 *     artifact with git backup.
 *   - light: Same interactive flow but concise output, single combined-reviewer
 *     subagent, no file save.
 *
 * Output path precedence (heavy mode):
 *   1. --output <path> flag in command args
 *   2. plan.outputDir in .pi/settings.json
 *   3. .plan/ (default)
 *
 * Usage:
 *   /plan <idea text or path>
 *   /plan heavy <idea text or path>
 *   /plan light <idea text or path>
 *   /plan heavy --output ./plans/ <idea text or path>
 *
 * Requires:
 *   - subagent extension (global: ~/.pi/agent/extensions/subagent/)
 *   - Bundled agents are symlinked into ~/.pi/agent/agents/ on load
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

export type PlanMode = "light" | "heavy";

const PLAN_BACKUP_NAMESPACE = "plan-backups";
const DEFAULT_OUTPUT_DIR = ".plan";

export interface ParsedPlanArgs {
  mode: PlanMode;
  idea: string;
  outputDir: string | null;
}

/**
 * Extract --output <path> from args string, returning the path and remaining args.
 * Handles both --output <path> and --output=<path>.
 */
export function extractOutputFlag(args: string): { outputDir: string | null; remaining: string } {
  // --output=<path>
  const eqMatch = args.match(/--output=(\S+)/i);
  if (eqMatch) {
    return {
      outputDir: eqMatch[1],
      remaining: args.replace(eqMatch[0], "").replace(/\s+/g, " ").trim(),
    };
  }
  // --output <path>
  const spaceMatch = args.match(/--output\s+(\S+)/i);
  if (spaceMatch) {
    return {
      outputDir: spaceMatch[1],
      remaining: args.replace(spaceMatch[0], "").replace(/\s+/g, " ").trim(),
    };
  }
  return { outputDir: null, remaining: args };
}

/**
 * Parse the raw command args into mode, idea text, and optional output dir.
 *
 * /plan light Add caching                    -> { mode: "light",  idea: "Add caching", outputDir: null }
 * /plan heavy --output ./plans/ Add caching  -> { mode: "heavy",  idea: "Add caching", outputDir: "./plans/" }
 * /plan --output ./plans/ Add caching        -> { mode: "heavy",  idea: "Add caching", outputDir: "./plans/" }
 * /plan Add caching                          -> { mode: "heavy",  idea: "Add caching", outputDir: null }
 */
export function parsePlanArgs(raw: string): ParsedPlanArgs {
  const { outputDir, remaining } = extractOutputFlag(raw);
  const trimmed = remaining.trim();

  const lightMatch = trimmed.match(/^light\s+([\s\S]+)$/i);
  if (lightMatch) {
    return { mode: "light", idea: lightMatch[1].trim(), outputDir };
  }
  const heavyMatch = trimmed.match(/^heavy\s+([\s\S]+)$/i);
  if (heavyMatch) {
    return { mode: "heavy", idea: heavyMatch[1].trim(), outputDir };
  }
  return { mode: "heavy", idea: trimmed, outputDir };
}

/**
 * Read plan.outputDir from .pi/settings.json if it exists.
 */
export function readOutputDirFromSettings(cwd: string): string | null {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  try {
    const content = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    const outputDir = settings?.plan?.outputDir;
    return typeof outputDir === "string" && outputDir.trim() ? outputDir.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the output directory using the precedence chain:
 *   1. --output flag (from parsed args)
 *   2. plan.outputDir in .pi/settings.json
 *   3. .plan/ (default)
 */
export function resolveOutputDir(flagValue: string | null, cwd: string): string {
  if (flagValue) return flagValue;
  const fromSettings = readOutputDirFromSettings(cwd);
  if (fromSettings) return fromSettings;
  return DEFAULT_OUTPUT_DIR;
}

/**
 * Detect whether a string looks like a file path rather than inline idea text.
 */
export function looksLikeFilePath(input: string): boolean {
  if (/\.(md|txt|markdown)$/i.test(input)) return true;
  if (/^[.~\/]/.test(input)) return true;
  return false;
}

/**
 * Read a file and strip optional YAML frontmatter.
 */
export function extractIdeaFromFile(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const content = fs.readFileSync(resolved, "utf-8");
  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (frontMatterMatch) {
    return frontMatterMatch[2].trim();
  }
  return content.trim();
}

/**
 * Build the plan prompt for a given mode, idea text, and output directory.
 */
export function buildPlanPrompt(mode: PlanMode, ideaText: string, outputDir?: string): string {
  if (mode === "heavy") {
    return buildHeavyPrompt(ideaText, outputDir ?? DEFAULT_OUTPUT_DIR);
  }
  return buildLightPrompt(ideaText);
}

/**
 * Extract plan_id from a file path given the output directory.
 * E.g., extractPlanId("custom-plans/my-plan.md", "custom-plans") -> "my-plan"
 */
export function extractPlanId(filePath: string, outputDir: string = DEFAULT_OUTPUT_DIR): string | null {
  // Normalize: strip trailing slashes
  const normalizedDir = outputDir.replace(/\/+$/, "");
  // Escape for regex
  const escaped = normalizedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|/)${escaped}/([^/]+)\\.md$`);
  const match = filePath.match(re);
  return match ? match[1] : null;
}

/**
 * Create a git backup of a plan file as an orphan commit.
 */
function createPlanBackup(cwd: string, planId: string, outputDir: string): void {
  const planFile = path.join(cwd, outputDir, `${planId}.md`);
  if (!fs.existsSync(planFile)) {
    throw new Error(`Plan file not found: ${planFile}`);
  }

  const content = fs.readFileSync(planFile, "utf-8");
  const gitOpts = { cwd, encoding: "utf-8" as const, stdio: ["pipe", "pipe", "pipe"] as const };

  const blobSha = execSync("git hash-object -w --stdin", { ...gitOpts, input: content }).toString().trim();

  // Build nested tree structure matching the output dir
  const dirParts = outputDir.split("/").filter(Boolean);
  let currentTree = execSync("git mktree", { ...gitOpts, input: `100644 blob ${blobSha}\t${planId}.md\n` }).toString().trim();
  for (let i = dirParts.length - 1; i >= 0; i--) {
    currentTree = execSync("git mktree", { ...gitOpts, input: `040000 tree ${currentTree}\t${dirParts[i]}\n` }).toString().trim();
  }

  const commitSha = execSync(`git commit-tree ${currentTree} -m "Backup of plan: ${planId}"`, gitOpts).toString().trim();
  execSync(`git update-ref refs/${PLAN_BACKUP_NAMESPACE}/${planId} ${commitSha}`, gitOpts);
}

/**
 * Ensure bundled agent .md files are symlinked into ~/.pi/agent/agents/.
 */
function symlinkBundledAgents(extensionDir: string): { linked: string[]; errors: string[] } {
  const agentsDir = path.join(extensionDir, "..", "agents");
  const targetDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const linked: string[] = [];
  const errors: string[] = [];

  if (!fs.existsSync(agentsDir)) {
    return { linked, errors };
  }

  fs.mkdirSync(targetDir, { recursive: true });

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return { linked, errors };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const source = path.join(agentsDir, entry.name);
    const target = path.join(targetDir, entry.name);

    try {
      // If target exists, check if it's already our symlink
      if (fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) {
        try {
          const existing = fs.readlinkSync(target);
          if (existing === source) {
            linked.push(entry.name);
            continue;
          }
        } catch {
          // Not a symlink — skip to avoid overwriting user files
          errors.push(`${entry.name}: target exists and is not our symlink, skipping`);
          continue;
        }
        // It's a symlink pointing elsewhere — update it
        fs.unlinkSync(target);
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        errors.push(`${entry.name}: ${err.message}`);
        continue;
      }
    }

    try {
      fs.symlinkSync(source, target);
      linked.push(entry.name);
    } catch (err: any) {
      errors.push(`${entry.name}: ${err.message}`);
    }
  }

  return { linked, errors };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildHeavyPrompt(ideaText: string, outputDir: string): string {
  return `Here is an initial idea for a plan that needs to be refined and formalized:

${ideaText}

Before you proceed, look for supporting docs such as \`AGENTS.md\` or \`CLAUDE.md\` in your current working directory; keep any guidance you find in mind while planning. Also check for \`docs/README.md\` and load any relevant domain documents it references.

Your task:
1. Use the available tools (read, bash, grep, find, ls) to examine the codebase and understand implementation context
2. Present 3-5 numbered assumptions about scope, approach, or constraints—things you believe are likely true based on the idea and codebase. I'll confirm which are correct and clarify any that are off.
   - Each assumption must be independent: correcting one should not affect others
   - Focus on assumptions you're most confident about, regardless of whether they're high-level or detailed
   - Avoid assumptions that overlap or would require the same correction
3. Ask me clarifying questions ONE AT A TIME until you fully understand the requirements
   - Focus on understanding what needs to be built and why
   - Clarify scope, constraints, and expected behavior
   - Skip questions already resolved by confirmed assumptions
4. Once requirements are clear, invoke the \`test-discovery\` subagent to analyze existing tests relevant to the proposed changes. Provide context about which modules/files will be affected and what functionality is being added or modified. Use \`agentScope: "user"\` to access the agents.
5. Ask any testing-related questions based on the discovery results (e.g., "Should we extend existing test X or create new tests?")
6. Draft your plan, then invoke the evaluation subagents **in parallel** using the subagent tool's parallel mode with \`agentScope: "user"\`:
   - \`maintainability-reviewer\`: Give it the draft plan text and ask it to review
   - \`test-reviewer\`: Give it the draft plan text (including the Unit Tests and Integration Tests sections) plus the test-discovery results, and ask it to review
7. Ask me additional clarifying questions if needed based on the subagent reviews
8. Generate a complete plan file and save it to \`${outputDir}/<plan_id>.md\` with this structure:
   - YAML front matter with: plan_id (unique, 3-100 chars, alphanumeric/._- only), status (use "draft")
   - Markdown body with: Objectives, Requirements & Constraints, Work Items, Deliverables, Out of Scope sections
   - Work Items section must include:
     - Unit Tests: Fast tests with mocked dependencies and no external API calls
     - Integration Tests: Tests that make real external API calls or test end-to-end functionality (identified as relevant to the changes)
   - Integration tests listed in the plan are required to pass for the task to be complete
9. After saving the plan, ask if any edits are needed

## Pre-planning Assumptions (Step 2)

Present your assumptions as a numbered list. I'll respond with which are correct and clarify any that are wrong. Example response: "1, 2, 4 are correct. 3 is wrong—we need to support both formats, not just JSON."

Good assumptions are independent—each stands alone:
- "The new endpoint will follow the existing REST patterns in the codebase"
- "This feature is internal-only and doesn't need public API documentation"
- "We'll add validation at the API boundary, not in the domain layer"

Avoid dependent assumptions where the answer to one changes or negates another:
- "We'll store user preferences in the database" AND "We'll add a preferences table with columns for theme and language"
  (If the first is wrong—say, we use a config file instead—the second becomes irrelevant)
- "This will be a synchronous operation" AND "We'll need to handle timeout errors from the queue"
  (If it's synchronous, there's no queue, so the timeout question doesn't apply)

## Using test-discovery (Step 4)

Invoke the \`test-discovery\` subagent via the subagent tool. Provide it context about:
- The proposed changes and affected modules
- The types of functionality being added or modified
- Any specific areas where test coverage concerns exist

Example subagent invocation:
\`\`\`
subagent({
  agent: "test-discovery",
  task: "The plan involves adding a new validation function and modifying existing merge logic. Affected files include X and Y. Analyze the existing test landscape for these areas.",
  agentScope: "user"
})
\`\`\`

test-discovery will report:
- Existing integration tests that must pass (these go in the plan's Work Items)
- Existing unit tests that may need modification
- Reusable fixtures and test patterns
- Coverage gaps to consider

## Using Evaluation Subagents (Step 6)

After drafting your plan, invoke both review subagents in parallel:

\`\`\`
subagent({
  tasks: [
    {
      agent: "maintainability-reviewer",
      task: "Review this plan for long-term maintenance concerns:\\n\\n<paste draft plan here>"
    },
    {
      agent: "test-reviewer",
      task: "Review this plan's test coverage. Here is the draft plan:\\n\\n<paste draft plan>\\n\\nHere are the test-discovery results:\\n\\n<paste discovery results>"
    }
  ],
  agentScope: "user"
})
\`\`\`

When you outline options or make suggestions, label them (e.g., Option 1, Option 2) so they are easy for me to reference.

## Plan File Guidelines

The plan file should focus on *what* needs to be built, not *how* to implement it. Avoid detailed code implementations—leave those to the developer. Code snippets are appropriate only when they define interfaces, schemas, or data layouts that constrain the design.`;
}

function buildLightPrompt(ideaText: string): string {
  return `Here is an initial idea for a plan that needs to be refined:

${ideaText}

Before you proceed, look for supporting docs such as \`AGENTS.md\` or \`CLAUDE.md\` in your current working directory; keep any guidance you find in mind while planning. Also check for \`docs/README.md\` and load any relevant domain documents it references.

Your task:
1. Use the available tools (read, bash, grep, find, ls) to examine the codebase and understand implementation context
2. Present 3-5 numbered assumptions about scope, approach, or constraints—things you believe are likely true based on the idea and codebase. I'll confirm which are correct and clarify any that are off.
   - Each assumption must be independent: correcting one should not affect others
   - Focus on assumptions you're most confident about, regardless of whether they're high-level or detailed
   - Avoid assumptions that overlap or would require the same correction
3. Ask me clarifying questions ONE AT A TIME until you fully understand the requirements
   - Focus on understanding what needs to be built and why
   - Clarify scope, constraints, and expected behavior
   - Skip questions already resolved by confirmed assumptions
4. Once requirements are clear, invoke the \`test-discovery\` subagent to analyze existing tests relevant to the proposed changes. Provide context about which modules/files will be affected and what functionality is being added or modified. Use \`agentScope: "user"\` to access the agents.
5. Ask any testing-related questions based on the discovery results (e.g., "Should we extend existing test X or create new tests?")
6. Draft a concise plan (keep it brief — key objectives, work items with test coverage, and out of scope), then invoke the \`combined-reviewer\` subagent with \`agentScope: "user"\` to review:
   \`\`\`
   subagent({
     agent: "combined-reviewer",
     task: "Review this plan for maintainability and test coverage:\\n\\n<paste draft plan>\\n\\nTest discovery results:\\n\\n<paste discovery results>",
     agentScope: "user"
   })
   \`\`\`
7. Ask me additional clarifying questions if needed based on the review
8. Present the final plan in chat (do NOT save to a file)

## Pre-planning Assumptions (Step 2)

Present your assumptions as a numbered list. I'll respond with which are correct and clarify any that are wrong. Example response: "1, 2, 4 are correct. 3 is wrong—we need to support both formats, not just JSON."

Good assumptions are independent—each stands alone:
- "The new endpoint will follow the existing REST patterns in the codebase"
- "This feature is internal-only and doesn't need public API documentation"
- "We'll add validation at the API boundary, not in the domain layer"

Avoid dependent assumptions where the answer to one changes or negates another:
- "We'll store user preferences in the database" AND "We'll add a preferences table with columns for theme and language"
  (If the first is wrong—say, we use a config file instead—the second becomes irrelevant)
- "This will be a synchronous operation" AND "We'll need to handle timeout errors from the queue"
  (If it's synchronous, there's no queue, so the timeout question doesn't apply)

When you outline options or make suggestions, label them (e.g., Option 1, Option 2) so they are easy for me to reference.

## Plan Format

Keep the plan concise and conversational — this is a lightweight plan, not a formal artifact. Cover:
- **Objectives**: What we're building and why
- **Work Items**: What needs to be done, including test coverage (unit and integration)
- **Out of Scope**: What we're explicitly not doing

The plan should focus on *what* needs to be built, not *how* to implement it.`;
}

// ---------------------------------------------------------------------------
// Tab completion
// ---------------------------------------------------------------------------

function getCompletions(prefix: string, cwd: string): AutocompleteItem[] | null {
  const items: AutocompleteItem[] = [];

  // If empty or partial first word, suggest mode keywords and --output
  const words = prefix.split(/\s+/);
  if (words.length <= 1) {
    const partial = words[0] || "";
    const keywords = [
      { value: "light ", label: "light", description: "Lightweight plan, no file saved" },
      { value: "heavy ", label: "heavy", description: "Full plan with subagent reviews and file output" },
      { value: "--output ", label: "--output", description: "Set output directory for plan file" },
    ];
    for (const kw of keywords) {
      if (kw.label.startsWith(partial.toLowerCase())) {
        items.push(kw);
      }
    }
  }

  // After mode keyword, suggest --output if not already present
  if (words.length === 2 && /^(light|heavy)$/i.test(words[0]) && !prefix.includes("--output")) {
    const partial = words[1] || "";
    if ("--output".startsWith(partial)) {
      items.push({ value: `${words[0]} --output `, label: "--output", description: "Set output directory for plan file" });
    }
  }

  // Suggest .md files from the project for idea file paths
  const lastWord = words[words.length - 1] || "";
  if (lastWord.endsWith(".") || looksLikeFilePath(lastWord) || lastWord === "") {
    try {
      const searchDir = lastWord.includes("/")
        ? path.resolve(cwd, path.dirname(lastWord))
        : cwd;
      if (fs.existsSync(searchDir)) {
        const entries = fs.readdirSync(searchDir, { withFileTypes: true });
        const dirPrefix = lastWord.includes("/") ? path.dirname(lastWord) + "/" : "";
        const filePartial = lastWord.includes("/") ? path.basename(lastWord) : lastWord;
        for (const entry of entries) {
          if (entry.name.startsWith(".") && !filePartial.startsWith(".")) continue;
          const fullValue = dirPrefix + entry.name;
          if (entry.isFile() && /\.(md|txt|markdown)$/i.test(entry.name) && entry.name.startsWith(filePartial)) {
            const beforeLast = words.slice(0, -1).join(" ");
            const completedValue = beforeLast ? `${beforeLast} ${fullValue}` : fullValue;
            items.push({ value: completedValue, label: fullValue, description: "Idea file" });
          }
          if (entry.isDirectory() && entry.name.startsWith(filePartial)) {
            const beforeLast = words.slice(0, -1).join(" ");
            const completedValue = beforeLast ? `${beforeLast} ${fullValue}/` : `${fullValue}/`;
            items.push({ value: completedValue, label: `${fullValue}/`, description: "Directory" });
          }
        }
      }
    } catch {
      // Ignore filesystem errors in completion
    }
  }

  return items.length > 0 ? items : null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Symlink bundled agents into ~/.pi/agent/agents/ on load
  const extensionDir = path.dirname(new URL(import.meta.url).pathname);
  const { linked, errors } = symlinkBundledAgents(extensionDir);
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`[plan] agent symlink warning: ${err}`);
    }
  }

  // Track the resolved output dir for git backup detection
  let activeOutputDir = DEFAULT_OUTPUT_DIR;

  // Watch for plan files being written and auto-backup (heavy mode)
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write") return;

    const writtenPath = (event.input as any)?.path as string | undefined;
    if (!writtenPath) return;

    const planId = extractPlanId(writtenPath, activeOutputDir);
    if (!planId) return;

    try {
      createPlanBackup(ctx.cwd, planId, activeOutputDir);
      ctx.ui.notify(`Plan backed up to refs/${PLAN_BACKUP_NAMESPACE}/${planId}`, "info");
    } catch (err: any) {
      ctx.ui.notify(`Plan backup failed: ${err.message}`, "warning");
    }
  });

  pi.registerCommand("plan", {
    description: "Start a structured planning session (usage: /plan [light|heavy] [--output <dir>] <idea>)",
    getArgumentCompletions: (prefix: string, ctx?: any): AutocompleteItem[] | null => {
      const cwd = ctx?.cwd || process.cwd();
      return getCompletions(prefix, cwd);
    },
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify(
          "Usage: /plan [light|heavy] [--output <dir>] <idea text or path to .md file>\n\nOutput path precedence:\n  1. --output flag\n  2. plan.outputDir in .pi/settings.json\n  3. .plan/ (default)\n\nExamples:\n  /plan Add a dashboard widget for recent activity\n  /plan light Add caching to the API layer\n  /plan heavy --output ./plans/ ideas/new-feature.md",
          "error",
        );
        return;
      }

      const { mode, idea, outputDir: flagOutputDir } = parsePlanArgs(args);
      const resolvedOutputDir = resolveOutputDir(flagOutputDir, ctx.cwd);
      activeOutputDir = resolvedOutputDir;

      let ideaText: string;
      if (looksLikeFilePath(idea)) {
        try {
          ideaText = extractIdeaFromFile(idea, ctx.cwd);
          ctx.ui.notify(`Loaded idea from: ${idea}`, "info");
        } catch (err: any) {
          ctx.ui.notify(err.message, "error");
          return;
        }
      } else {
        ideaText = idea;
      }

      const fullPrompt = buildPlanPrompt(mode, ideaText, resolvedOutputDir);
      const outputInfo = mode === "heavy" ? ` → ${resolvedOutputDir}/` : "";
      ctx.ui.notify(`Starting ${mode} planning session...${outputInfo}`, "info");
      pi.sendUserMessage(fullPrompt);
    },
  });
}
