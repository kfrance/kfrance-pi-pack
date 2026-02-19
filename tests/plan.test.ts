import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parsePlanArgs,
  extractOutputFlag,
  looksLikeFilePath,
  extractIdeaFromFile,
  buildPlanPrompt,
  extractPlanId,
  resolveOutputDir,
  readOutputDirFromSettings,
  type PlanMode,
} from "../extensions/plan.ts";

// ---------------------------------------------------------------------------
// extractOutputFlag
// ---------------------------------------------------------------------------

describe("extractOutputFlag", () => {
  it("extracts --output with space-separated path", () => {
    const result = extractOutputFlag("--output ./plans/ Add caching");
    assert.strictEqual(result.outputDir, "./plans/");
    assert.strictEqual(result.remaining, "Add caching");
  });

  it("extracts --output= with equals-separated path", () => {
    const result = extractOutputFlag("--output=./plans/ Add caching");
    assert.strictEqual(result.outputDir, "./plans/");
    assert.strictEqual(result.remaining, "Add caching");
  });

  it("returns null when no --output flag present", () => {
    const result = extractOutputFlag("heavy Add caching");
    assert.strictEqual(result.outputDir, null);
    assert.strictEqual(result.remaining, "heavy Add caching");
  });

  it("handles --output in the middle of args", () => {
    const result = extractOutputFlag("heavy --output ./plans/ Add caching");
    assert.strictEqual(result.outputDir, "./plans/");
    assert.strictEqual(result.remaining, "heavy Add caching");
  });

  it("handles --output at the end (path is last word)", () => {
    const result = extractOutputFlag("heavy --output ./plans/");
    assert.strictEqual(result.outputDir, "./plans/");
    assert.strictEqual(result.remaining, "heavy");
  });

  it("collapses extra whitespace after removal", () => {
    const result = extractOutputFlag("heavy  --output ./plans/  Add  caching");
    assert.strictEqual(result.outputDir, "./plans/");
    assert.ok(!result.remaining.includes("  "), "should not have double spaces");
  });
});

// ---------------------------------------------------------------------------
// parsePlanArgs
// ---------------------------------------------------------------------------

describe("parsePlanArgs", () => {
  it("defaults to heavy mode when no mode keyword is given", () => {
    const result = parsePlanArgs("Add caching to the API layer");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "Add caching to the API layer");
    assert.strictEqual(result.outputDir, null);
  });

  it("parses explicit heavy mode", () => {
    const result = parsePlanArgs("heavy Add caching");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "Add caching");
  });

  it("parses explicit light mode", () => {
    const result = parsePlanArgs("light Add caching");
    assert.strictEqual(result.mode, "light");
    assert.strictEqual(result.idea, "Add caching");
  });

  it("is case-insensitive for mode keyword", () => {
    assert.strictEqual(parsePlanArgs("LIGHT some idea").mode, "light");
    assert.strictEqual(parsePlanArgs("Heavy some idea").mode, "heavy");
    assert.strictEqual(parsePlanArgs("HEAVY some idea").mode, "heavy");
    assert.strictEqual(parsePlanArgs("Light some idea").mode, "light");
  });

  it("trims whitespace from input", () => {
    const result = parsePlanArgs("  light   Add caching  ");
    assert.strictEqual(result.mode, "light");
    assert.strictEqual(result.idea, "Add caching");
  });

  it("treats 'light' alone (no idea) as heavy mode with idea 'light'", () => {
    const result = parsePlanArgs("light");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "light");
  });

  it("treats 'heavy' alone (no idea) as heavy mode with idea 'heavy'", () => {
    const result = parsePlanArgs("heavy");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "heavy");
  });

  it("handles file paths after mode keyword", () => {
    const result = parsePlanArgs("light ideas/feature.md");
    assert.strictEqual(result.mode, "light");
    assert.strictEqual(result.idea, "ideas/feature.md");
  });

  it("does not treat 'lightweight' as light mode", () => {
    const result = parsePlanArgs("lightweight approach to caching");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "lightweight approach to caching");
  });

  it("preserves multi-line idea text", () => {
    const result = parsePlanArgs("light Add caching\nwith Redis support");
    assert.strictEqual(result.mode, "light");
    assert.strictEqual(result.idea, "Add caching\nwith Redis support");
  });

  it("extracts --output flag and passes it through", () => {
    const result = parsePlanArgs("heavy --output ./plans/ Add caching");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "Add caching");
    assert.strictEqual(result.outputDir, "./plans/");
  });

  it("extracts --output before mode keyword", () => {
    const result = parsePlanArgs("--output ./plans/ heavy Add caching");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "Add caching");
    assert.strictEqual(result.outputDir, "./plans/");
  });

  it("extracts --output with default heavy mode", () => {
    const result = parsePlanArgs("--output ./plans/ Add caching");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "Add caching");
    assert.strictEqual(result.outputDir, "./plans/");
  });
});

// ---------------------------------------------------------------------------
// looksLikeFilePath
// ---------------------------------------------------------------------------

describe("looksLikeFilePath", () => {
  it("detects .md files", () => {
    assert.strictEqual(looksLikeFilePath("ideas/feature.md"), true);
  });

  it("detects .txt files", () => {
    assert.strictEqual(looksLikeFilePath("notes.txt"), true);
  });

  it("detects .markdown files", () => {
    assert.strictEqual(looksLikeFilePath("plan.markdown"), true);
  });

  it("detects relative paths starting with ./", () => {
    assert.strictEqual(looksLikeFilePath("./some-file"), true);
  });

  it("detects absolute paths starting with /", () => {
    assert.strictEqual(looksLikeFilePath("/tmp/idea"), true);
  });

  it("detects home-relative paths starting with ~/", () => {
    assert.strictEqual(looksLikeFilePath("~/ideas/feature"), true);
  });

  it("returns false for plain text", () => {
    assert.strictEqual(looksLikeFilePath("Add caching to the API layer"), false);
  });

  it("returns false for text containing dots but not file extensions", () => {
    assert.strictEqual(looksLikeFilePath("Implement v2.0 features"), false);
  });

  it("returns false for multi-word text ending with .md", () => {
    assert.strictEqual(looksLikeFilePath("Let's finalize the plan outlined in @app_design.md app_design.md"), false);
  });

  it("returns false for text with spaces even if it contains a path-like segment", () => {
    assert.strictEqual(looksLikeFilePath("finalize plan in ideas/feature.md"), false);
  });

  it("is case-insensitive for extensions", () => {
    assert.strictEqual(looksLikeFilePath("PLAN.MD"), true);
    assert.strictEqual(looksLikeFilePath("notes.TXT"), true);
  });
});

// ---------------------------------------------------------------------------
// extractIdeaFromFile
// ---------------------------------------------------------------------------

describe("extractIdeaFromFile", () => {
  let tmpDir: string;

  it("reads plain text file content", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const filePath = path.join(tmpDir, "idea.md");
    fs.writeFileSync(filePath, "Build a new dashboard widget");

    const result = extractIdeaFromFile("idea.md", tmpDir);
    assert.strictEqual(result, "Build a new dashboard widget");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("strips YAML frontmatter", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const filePath = path.join(tmpDir, "idea.md");
    fs.writeFileSync(filePath, "---\ntitle: My Idea\nstatus: draft\n---\nBuild a new dashboard widget");

    const result = extractIdeaFromFile("idea.md", tmpDir);
    assert.strictEqual(result, "Build a new dashboard widget");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws for missing file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    assert.throws(
      () => extractIdeaFromFile("nonexistent.md", tmpDir),
      /File not found/,
    );
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles file with only frontmatter (empty body)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const filePath = path.join(tmpDir, "idea.md");
    fs.writeFileSync(filePath, "---\ntitle: Empty\n---\n");

    const result = extractIdeaFromFile("idea.md", tmpDir);
    assert.strictEqual(result, "");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("resolves relative paths against cwd", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const subdir = path.join(tmpDir, "ideas");
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, "feature.md"), "Add caching");

    const result = extractIdeaFromFile("ideas/feature.md", tmpDir);
    assert.strictEqual(result, "Add caching");
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// buildPlanPrompt
// ---------------------------------------------------------------------------

describe("buildPlanPrompt", () => {
  it("heavy mode includes subagent instructions for parallel reviewers", () => {
    const prompt = buildPlanPrompt("heavy", "Add caching");
    assert.ok(prompt.includes("maintainability-reviewer"));
    assert.ok(prompt.includes("test-reviewer"));
    assert.ok(prompt.includes("test-discovery"));
  });

  it("heavy mode uses default output dir when not specified", () => {
    const prompt = buildPlanPrompt("heavy", "Add caching");
    assert.ok(prompt.includes(".plan/<plan_id>.md"));
  });

  it("heavy mode uses custom output dir when specified", () => {
    const prompt = buildPlanPrompt("heavy", "Add caching", "custom-plans");
    assert.ok(prompt.includes("custom-plans/<plan_id>.md"));
    assert.ok(!prompt.includes(".plan/<plan_id>.md"));
  });

  it("heavy mode includes the idea text", () => {
    const prompt = buildPlanPrompt("heavy", "Build a widget");
    assert.ok(prompt.includes("Build a widget"));
  });

  it("light mode includes combined-reviewer instead of separate reviewers", () => {
    const prompt = buildPlanPrompt("light", "Add caching");
    assert.ok(prompt.includes("combined-reviewer"));
    assert.ok(!prompt.includes("maintainability-reviewer"));
    assert.ok(!prompt.includes("test-reviewer"));
  });

  it("light mode does NOT instruct to save a file", () => {
    const prompt = buildPlanPrompt("light", "Add caching");
    assert.ok(prompt.includes("do NOT save to a file"));
  });

  it("light mode ignores outputDir parameter", () => {
    const prompt = buildPlanPrompt("light", "Add caching", "custom-plans");
    assert.ok(!prompt.includes("custom-plans"));
    assert.ok(prompt.includes("do NOT save to a file"));
  });

  it("light mode includes the idea text", () => {
    const prompt = buildPlanPrompt("light", "Build a widget");
    assert.ok(prompt.includes("Build a widget"));
  });

  it("both modes include assumptions instructions", () => {
    for (const mode of ["light", "heavy"] as PlanMode[]) {
      const prompt = buildPlanPrompt(mode, "idea");
      assert.ok(prompt.includes("3-5 numbered assumptions"), `${mode} should include assumptions`);
      assert.ok(prompt.includes("independent"), `${mode} should mention independence`);
    }
  });

  it("both modes include test-discovery step", () => {
    for (const mode of ["light", "heavy"] as PlanMode[]) {
      const prompt = buildPlanPrompt(mode, "idea");
      assert.ok(prompt.includes("test-discovery"), `${mode} should include test-discovery`);
    }
  });

  it("heavy mode includes YAML frontmatter instructions", () => {
    const prompt = buildPlanPrompt("heavy", "idea");
    assert.ok(prompt.includes("YAML front matter"));
    assert.ok(prompt.includes("plan_id"));
    assert.ok(prompt.includes("status"));
  });

  it("heavy mode does not include evaluation_notes or git_sha", () => {
    const prompt = buildPlanPrompt("heavy", "idea");
    assert.ok(!prompt.includes("evaluation_notes"));
    assert.ok(!prompt.includes("git_sha"));
  });
});

// ---------------------------------------------------------------------------
// extractPlanId
// ---------------------------------------------------------------------------

describe("extractPlanId", () => {
  it("extracts plan_id from default .plan/ path", () => {
    assert.strictEqual(extractPlanId(".plan/my-plan.md"), "my-plan");
  });

  it("extracts plan_id with dots and underscores", () => {
    assert.strictEqual(extractPlanId(".plan/v2.0_feature.md"), "v2.0_feature");
  });

  it("returns null for non-.plan paths with default dir", () => {
    assert.strictEqual(extractPlanId("docs/plan.md"), null);
    assert.strictEqual(extractPlanId("src/plan/thing.md"), null);
  });

  it("returns null for nested paths inside .plan", () => {
    assert.strictEqual(extractPlanId(".plan/sub/thing.md"), null);
  });

  it("extracts plan_id with custom output dir", () => {
    assert.strictEqual(extractPlanId("custom-plans/my-plan.md", "custom-plans"), "my-plan");
  });

  it("extracts plan_id with nested custom output dir", () => {
    assert.strictEqual(extractPlanId("docs/plans/my-plan.md", "docs/plans"), "my-plan");
  });

  it("handles custom output dir with trailing slash", () => {
    assert.strictEqual(extractPlanId("plans/my-plan.md", "plans/"), "my-plan");
  });

  it("returns null when path doesn't match custom output dir", () => {
    assert.strictEqual(extractPlanId(".plan/my-plan.md", "custom-plans"), null);
  });

  it("extracts from path with leading directory", () => {
    assert.strictEqual(extractPlanId("/home/user/project/.plan/my-plan.md"), "my-plan");
  });

  it("extracts from path with leading directory and custom dir", () => {
    assert.strictEqual(extractPlanId("/home/user/project/plans/my-plan.md", "plans"), "my-plan");
  });
});

// ---------------------------------------------------------------------------
// resolveOutputDir
// ---------------------------------------------------------------------------

describe("resolveOutputDir", () => {
  let tmpDir: string;

  it("uses flag value when provided", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    assert.strictEqual(resolveOutputDir("./custom/", tmpDir), "./custom/");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("reads from .pi/settings.json when no flag", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ plan: { outputDir: "my-plans" } }));

    assert.strictEqual(resolveOutputDir(null, tmpDir), "my-plans");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("defaults to .plan when no flag and no settings", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    assert.strictEqual(resolveOutputDir(null, tmpDir), ".plan");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("flag takes precedence over settings", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ plan: { outputDir: "from-settings" } }));

    assert.strictEqual(resolveOutputDir("from-flag", tmpDir), "from-flag");
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// readOutputDirFromSettings
// ---------------------------------------------------------------------------

describe("readOutputDirFromSettings", () => {
  let tmpDir: string;

  it("returns null when .pi/settings.json doesn't exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    assert.strictEqual(readOutputDirFromSettings(tmpDir), null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns null when settings has no plan key", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ theme: "dark" }));

    assert.strictEqual(readOutputDirFromSettings(tmpDir), null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns null when plan.outputDir is empty string", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ plan: { outputDir: "" } }));

    assert.strictEqual(readOutputDirFromSettings(tmpDir), null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns the outputDir when set", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ plan: { outputDir: "my-plans" } }));

    assert.strictEqual(readOutputDirFromSettings(tmpDir), "my-plans");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns null for invalid JSON", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(path.join(piDir, "settings.json"), "not json{{{");

    assert.strictEqual(readOutputDirFromSettings(tmpDir), null);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
