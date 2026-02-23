import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parsePlanArgs,
  extractOutputFlag,
  extractLinearFlag,
  extractNoBranchFlag,
  validatePlanInput,
  looksLikeFilePath,
  extractIdeaFromFile,
  buildPlanPrompt,
  extractPlanId,
  resolveOutputDir,
  readOutputDirFromSettings,
  type PlanMode,
  type ParsedPlanArgs,
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
// extractLinearFlag
// ---------------------------------------------------------------------------

describe("extractLinearFlag", () => {
  it("extracts --linear with space-separated issueId", () => {
    const result = extractLinearFlag("--linear ENG-123 Add caching");
    assert.strictEqual(result.linearIssue, "ENG-123");
    assert.strictEqual(result.remaining, "Add caching");
  });

  it("extracts --linear= with equals-separated issueId", () => {
    const result = extractLinearFlag("--linear=ENG-123 Add caching");
    assert.strictEqual(result.linearIssue, "ENG-123");
    assert.strictEqual(result.remaining, "Add caching");
  });

  it("returns null when no --linear flag present", () => {
    const result = extractLinearFlag("heavy Add caching");
    assert.strictEqual(result.linearIssue, null);
    assert.strictEqual(result.remaining, "heavy Add caching");
  });

  it("handles --linear in the middle of args", () => {
    const result = extractLinearFlag("heavy --linear ENG-123 Add caching");
    assert.strictEqual(result.linearIssue, "ENG-123");
    assert.strictEqual(result.remaining, "heavy Add caching");
  });

  it("does not consume mode keyword as issueId", () => {
    const result = extractLinearFlag("--linear heavy Add caching");
    assert.strictEqual(result.linearIssue, null);
    assert.strictEqual(result.remaining, "heavy Add caching");
  });

  it("does not consume another flag as issueId", () => {
    const result = extractLinearFlag("--linear --output ./plans/");
    assert.strictEqual(result.linearIssue, null);
    assert.strictEqual(result.remaining, "--output ./plans/");
  });

  it("returns null when --linear is at end with no value", () => {
    const result = extractLinearFlag("heavy --linear");
    assert.strictEqual(result.linearIssue, null);
    assert.strictEqual(result.remaining, "heavy");
  });

  it("returns null when --linear is alone", () => {
    const result = extractLinearFlag("--linear");
    assert.strictEqual(result.linearIssue, null);
    assert.strictEqual(result.remaining, "");
  });

  it("collapses extra whitespace after removal", () => {
    const result = extractLinearFlag("heavy  --linear ENG-123  Add caching");
    assert.strictEqual(result.linearIssue, "ENG-123");
    assert.ok(!result.remaining.includes("  "), "should not have double spaces");
  });
});

// ---------------------------------------------------------------------------
// extractNoBranchFlag
// ---------------------------------------------------------------------------

describe("extractNoBranchFlag", () => {
  it("extracts --no-branch when present", () => {
    const result = extractNoBranchFlag("--no-branch Add caching");
    assert.strictEqual(result.noBranch, true);
    assert.strictEqual(result.remaining, "Add caching");
  });

  it("returns false when --no-branch not present", () => {
    const result = extractNoBranchFlag("heavy Add caching");
    assert.strictEqual(result.noBranch, false);
    assert.strictEqual(result.remaining, "heavy Add caching");
  });

  it("handles --no-branch in the middle of args", () => {
    const result = extractNoBranchFlag("heavy --no-branch Add caching");
    assert.strictEqual(result.noBranch, true);
    assert.strictEqual(result.remaining, "heavy Add caching");
  });

  it("handles --no-branch at end", () => {
    const result = extractNoBranchFlag("heavy --no-branch");
    assert.strictEqual(result.noBranch, true);
    assert.strictEqual(result.remaining, "heavy");
  });
});

// ---------------------------------------------------------------------------
// validatePlanInput
// ---------------------------------------------------------------------------

describe("validatePlanInput", () => {
  it("returns error when both --linear and idea text are provided", () => {
    const parsed: ParsedPlanArgs = { mode: "heavy", idea: "some text", outputDir: null, linearIssue: "ENG-123", noBranch: false };
    const error = validatePlanInput(parsed);
    assert.ok(error !== null);
    assert.ok(error!.includes("Cannot use --linear"));
  });

  it("returns error when neither --linear nor idea text is provided", () => {
    const parsed: ParsedPlanArgs = { mode: "heavy", idea: "", outputDir: null, linearIssue: null, noBranch: false };
    const error = validatePlanInput(parsed);
    assert.ok(error !== null);
    assert.ok(error!.includes("No idea provided"));
  });

  it("returns null when --linear is provided without idea text", () => {
    const parsed: ParsedPlanArgs = { mode: "heavy", idea: "", outputDir: null, linearIssue: "ENG-123", noBranch: false };
    assert.strictEqual(validatePlanInput(parsed), null);
  });

  it("returns null when idea text is provided without --linear", () => {
    const parsed: ParsedPlanArgs = { mode: "heavy", idea: "Add caching", outputDir: null, linearIssue: null, noBranch: false };
    assert.strictEqual(validatePlanInput(parsed), null);
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
    assert.strictEqual(result.linearIssue, null);
    assert.strictEqual(result.noBranch, false);
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

  it("extracts --linear with heavy mode (default)", () => {
    const result = parsePlanArgs("--linear ENG-123");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "");
    assert.strictEqual(result.linearIssue, "ENG-123");
  });

  it("extracts --linear with explicit light mode", () => {
    const result = parsePlanArgs("light --linear ENG-123");
    assert.strictEqual(result.mode, "light");
    assert.strictEqual(result.idea, "");
    assert.strictEqual(result.linearIssue, "ENG-123");
  });

  it("extracts --linear with explicit heavy mode", () => {
    const result = parsePlanArgs("heavy --linear ENG-123");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "");
    assert.strictEqual(result.linearIssue, "ENG-123");
  });

  it("does not consume 'heavy' as issueId after --linear", () => {
    const result = parsePlanArgs("--linear heavy Add thing");
    assert.strictEqual(result.linearIssue, null);
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "Add thing");
  });

  it("extracts --linear combined with --output", () => {
    const result = parsePlanArgs("heavy --output ./plans/ --linear ENG-123");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "");
    assert.strictEqual(result.outputDir, "./plans/");
    assert.strictEqual(result.linearIssue, "ENG-123");
  });

  it("extracts --no-branch flag", () => {
    const result = parsePlanArgs("--no-branch Add caching");
    assert.strictEqual(result.mode, "heavy");
    assert.strictEqual(result.idea, "Add caching");
    assert.strictEqual(result.noBranch, true);
  });

  it("extracts --no-branch with mode keyword", () => {
    const result = parsePlanArgs("light --no-branch Add caching");
    assert.strictEqual(result.mode, "light");
    assert.strictEqual(result.idea, "Add caching");
    assert.strictEqual(result.noBranch, true);
  });

  it("combines --linear and --no-branch", () => {
    const result = parsePlanArgs("--linear ENG-123 --no-branch");
    assert.strictEqual(result.linearIssue, "ENG-123");
    assert.strictEqual(result.noBranch, true);
    assert.strictEqual(result.idea, "");
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

  it("heavy mode includes test-discovery step", () => {
    const prompt = buildPlanPrompt("heavy", "idea");
    assert.ok(prompt.includes("test-discovery"), "heavy should include test-discovery");
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

  it("light mode does NOT include test-discovery", () => {
    const prompt = buildPlanPrompt("light", "idea");
    assert.ok(!prompt.includes("test-discovery"), "light mode should not mention test-discovery");
  });

  // Branch creation tests
  it("includes git checkout -b instruction by default (no linear, no noBranch)", () => {
    for (const mode of ["light", "heavy"] as PlanMode[]) {
      const prompt = buildPlanPrompt(mode, "idea", undefined, {});
      assert.ok(prompt.includes("git checkout -b"), `${mode} should include git checkout -b`);
      assert.ok(prompt.includes("Branch Creation"), `${mode} should include Branch Creation section`);
    }
  });

  it("includes linear issue start when linearIssue is provided", () => {
    for (const mode of ["light", "heavy"] as PlanMode[]) {
      const prompt = buildPlanPrompt(mode, "idea", undefined, { linearIssue: "ENG-123" });
      assert.ok(prompt.includes("linear issue start ENG-123"), `${mode} should include linear issue start`);
      assert.ok(!prompt.includes("git checkout -b"), `${mode} should NOT include git checkout -b when linear`);
    }
  });

  it("does NOT include branch instructions when noBranch is true", () => {
    for (const mode of ["light", "heavy"] as PlanMode[]) {
      const prompt = buildPlanPrompt(mode, "idea", undefined, { noBranch: true });
      assert.ok(!prompt.includes("Branch Creation"), `${mode} should not include Branch Creation`);
      assert.ok(!prompt.includes("git checkout -b"), `${mode} should not include git checkout -b`);
      assert.ok(!prompt.includes("linear issue start"), `${mode} should not include linear issue start`);
    }
  });

  it("noBranch suppresses branch even with linearIssue", () => {
    const prompt = buildPlanPrompt("heavy", "idea", undefined, { linearIssue: "ENG-123", noBranch: true });
    assert.ok(!prompt.includes("Branch Creation"));
    assert.ok(!prompt.includes("linear issue start"));
  });

  // Linear front matter tests
  it("heavy mode includes linear_issue in front matter instruction when linearIssue provided", () => {
    const prompt = buildPlanPrompt("heavy", "idea", undefined, { linearIssue: "ENG-123" });
    assert.ok(prompt.includes('linear_issue'), "heavy should include linear_issue front matter");
    assert.ok(prompt.includes('ENG-123'), "heavy should include the issue ID");
  });

  it("light mode does NOT include linear_issue front matter instruction", () => {
    const prompt = buildPlanPrompt("light", "idea", undefined, { linearIssue: "ENG-123" });
    assert.ok(!prompt.includes("linear_issue"), "light mode should not include linear_issue front matter");
  });

  it("no linear instructions when linearIssue is not provided", () => {
    for (const mode of ["light", "heavy"] as PlanMode[]) {
      const prompt = buildPlanPrompt(mode, "idea", undefined, {});
      assert.ok(!prompt.includes("linear issue start"), `${mode} should not include linear issue start`);
      assert.ok(!prompt.includes("linear_issue"), `${mode} should not include linear_issue front matter`);
    }
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
