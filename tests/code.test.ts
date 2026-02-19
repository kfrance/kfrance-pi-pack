import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseFrontmatterStatus,
  updateFrontmatterStatus,
  updatePlanFileStatus,
  getDraftPlanIds,
  resolvePlanPath,
  buildImplementationPrompt,
  buildSystemPromptAddendum,
} from "../extensions/code.ts";

// ---------------------------------------------------------------------------
// Helper: create a temp dir, auto-cleanup
// ---------------------------------------------------------------------------

function withTmpDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

function makePlan(
  dir: string,
  name: string,
  status: string,
  body: string = "# Plan body",
): string {
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(
    filePath,
    `---\nplan_id: ${name}\nstatus: ${status}\n---\n${body}`,
  );
  return filePath;
}

// ---------------------------------------------------------------------------
// parseFrontmatterStatus
// ---------------------------------------------------------------------------

describe("parseFrontmatterStatus", () => {
  it("parses unquoted status", () => {
    const content = "---\nplan_id: test\nstatus: draft\n---\n# Body";
    assert.strictEqual(parseFrontmatterStatus(content), "draft");
  });

  it("parses single-quoted status", () => {
    const content = "---\nstatus: 'draft'\n---\n# Body";
    assert.strictEqual(parseFrontmatterStatus(content), "draft");
  });

  it("parses double-quoted status", () => {
    const content = '---\nstatus: "draft"\n---\n# Body';
    assert.strictEqual(parseFrontmatterStatus(content), "draft");
  });

  it("parses status with trailing whitespace", () => {
    const content = "---\nstatus: draft   \n---\n# Body";
    assert.strictEqual(parseFrontmatterStatus(content), "draft");
  });

  it("parses ai-attempted status (hyphenated)", () => {
    const content = "---\nstatus: ai-attempted\n---\n# Body";
    assert.strictEqual(parseFrontmatterStatus(content), "ai-attempted");
  });

  it("returns null for missing frontmatter", () => {
    assert.strictEqual(parseFrontmatterStatus("# Just a heading"), null);
  });

  it("returns null for frontmatter without status key", () => {
    const content = "---\nplan_id: test\ntitle: My Plan\n---\n# Body";
    assert.strictEqual(parseFrontmatterStatus(content), null);
  });

  it("returns null for malformed frontmatter (no closing ---)", () => {
    const content = "---\nstatus: draft\n# Body";
    assert.strictEqual(parseFrontmatterStatus(content), null);
  });
});

// ---------------------------------------------------------------------------
// updateFrontmatterStatus
// ---------------------------------------------------------------------------

describe("updateFrontmatterStatus", () => {
  it("updates unquoted status", () => {
    const input = "---\nplan_id: test\nstatus: draft\n---\n# Body";
    const result = updateFrontmatterStatus(input, "coding");
    assert.strictEqual(result, "---\nplan_id: test\nstatus: coding\n---\n# Body");
  });

  it("updates single-quoted status", () => {
    const input = "---\nstatus: 'draft'\n---\n# Body";
    const result = updateFrontmatterStatus(input, "coding");
    assert.strictEqual(result, "---\nstatus: coding\n---\n# Body");
  });

  it("updates double-quoted status", () => {
    const input = '---\nstatus: "draft"\n---\n# Body';
    const result = updateFrontmatterStatus(input, "coding");
    assert.strictEqual(result, "---\nstatus: coding\n---\n# Body");
  });

  it("updates status with trailing whitespace (preserves trailing whitespace)", () => {
    const input = "---\nstatus: draft   \n---\n# Body";
    const result = updateFrontmatterStatus(input, "coding");
    assert.strictEqual(result, "---\nstatus: coding   \n---\n# Body");
  });

  it("preserves all other frontmatter fields and body", () => {
    const input = [
      "---",
      "plan_id: my-feature",
      "status: draft",
      "title: My Feature Plan",
      "tags: [a, b]",
      "---",
      "",
      "# My Feature",
      "",
      "Some body content here.",
    ].join("\n");

    const result = updateFrontmatterStatus(input, "coding");

    const expected = [
      "---",
      "plan_id: my-feature",
      "status: coding",
      "title: My Feature Plan",
      "tags: [a, b]",
      "---",
      "",
      "# My Feature",
      "",
      "Some body content here.",
    ].join("\n");

    assert.strictEqual(result, expected);
  });

  it("handles coding → ai-attempted transition", () => {
    const input = "---\nstatus: coding\n---\n# Body";
    const result = updateFrontmatterStatus(input, "ai-attempted");
    assert.strictEqual(result, "---\nstatus: ai-attempted\n---\n# Body");
  });

  it("is idempotent — updating to same status produces unchanged content", () => {
    const input = "---\nstatus: draft\n---\n# Body";
    const result = updateFrontmatterStatus(input, "draft");
    assert.strictEqual(result, input);
  });

  it("throws on missing frontmatter", () => {
    assert.throws(
      () => updateFrontmatterStatus("# Just a heading", "coding"),
      /No valid YAML frontmatter found/,
    );
  });

  it("throws on frontmatter without status key", () => {
    const input = "---\nplan_id: test\ntitle: My Plan\n---\n# Body";
    assert.throws(
      () => updateFrontmatterStatus(input, "coding"),
      /No status field found/,
    );
  });
});

// ---------------------------------------------------------------------------
// updatePlanFileStatus
// ---------------------------------------------------------------------------

describe("updatePlanFileStatus", () => {
  it("updates status in a real file", () => {
    withTmpDir((dir) => {
      const filePath = makePlan(dir, "test-plan", "draft");
      updatePlanFileStatus(filePath, "coding");

      const content = fs.readFileSync(filePath, "utf-8");
      assert.strictEqual(parseFrontmatterStatus(content), "coding");
    });
  });

  it("preserves body content when updating file", () => {
    withTmpDir((dir) => {
      const body = "# My Plan\n\nDetailed body content.\n\n- Item 1\n- Item 2";
      const filePath = makePlan(dir, "test-plan", "draft", body);
      updatePlanFileStatus(filePath, "coding");

      const content = fs.readFileSync(filePath, "utf-8");
      assert.ok(content.includes(body));
    });
  });

  it("throws on file not found", () => {
    assert.throws(
      () => updatePlanFileStatus("/nonexistent/path/plan.md", "coding"),
      /Plan file not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// getDraftPlanIds
// ---------------------------------------------------------------------------

describe("getDraftPlanIds", () => {
  it("finds draft plans in a given directory", () => {
    withTmpDir((dir) => {
      makePlan(dir, "feature-a", "draft");
      makePlan(dir, "feature-b", "draft");

      const result = getDraftPlanIds(dir, "/");
      assert.ok(result);
      assert.strictEqual(result.length, 2);
      const values = result.map((r) => r.value);
      assert.ok(values.includes("feature-a"));
      assert.ok(values.includes("feature-b"));
    });
  });

  it("ignores non-draft status (coding, ai-attempted)", () => {
    withTmpDir((dir) => {
      makePlan(dir, "draft-plan", "draft");
      makePlan(dir, "coding-plan", "coding");
      makePlan(dir, "attempted-plan", "ai-attempted");

      const result = getDraftPlanIds(dir, "/");
      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].value, "draft-plan");
    });
  });

  it("returns null for missing directory", () => {
    const result = getDraftPlanIds("/nonexistent/dir", "/");
    assert.strictEqual(result, null);
  });

  it("returns null for empty directory", () => {
    withTmpDir((dir) => {
      const result = getDraftPlanIds(dir, "/");
      assert.strictEqual(result, null);
    });
  });

  it("ignores files with malformed frontmatter", () => {
    withTmpDir((dir) => {
      makePlan(dir, "good-plan", "draft");
      // Write a file with no frontmatter
      fs.writeFileSync(path.join(dir, "bad-plan.md"), "# No frontmatter");

      const result = getDraftPlanIds(dir, "/");
      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].value, "good-plan");
    });
  });

  it("accepts output directory as parameter (not hardcoded)", () => {
    withTmpDir((dir) => {
      const subDir = path.join(dir, "custom-plans");
      fs.mkdirSync(subDir);
      makePlan(subDir, "plan-in-subdir", "draft");

      // Pass subDir as absolute path
      const result = getDraftPlanIds(subDir, "/");
      assert.ok(result);
      assert.strictEqual(result[0].value, "plan-in-subdir");
    });
  });

  it("resolves relative output dir against cwd", () => {
    withTmpDir((dir) => {
      const subDir = path.join(dir, ".plan");
      fs.mkdirSync(subDir);
      makePlan(subDir, "relative-plan", "draft");

      const result = getDraftPlanIds(".plan", dir);
      assert.ok(result);
      assert.strictEqual(result[0].value, "relative-plan");
    });
  });

  it("filters by prefix", () => {
    withTmpDir((dir) => {
      makePlan(dir, "feature-auth", "draft");
      makePlan(dir, "feature-cache", "draft");
      makePlan(dir, "bugfix-123", "draft");

      const result = getDraftPlanIds(dir, "/", "feature");
      assert.ok(result);
      assert.strictEqual(result.length, 2);
      const values = result.map((r) => r.value);
      assert.ok(values.includes("feature-auth"));
      assert.ok(values.includes("feature-cache"));
    });
  });

  it("empty prefix returns all draft plans", () => {
    withTmpDir((dir) => {
      makePlan(dir, "alpha", "draft");
      makePlan(dir, "beta", "draft");

      const result = getDraftPlanIds(dir, "/", "");
      assert.ok(result);
      assert.strictEqual(result.length, 2);
    });
  });

  it("prefix matching nothing returns null", () => {
    withTmpDir((dir) => {
      makePlan(dir, "feature-a", "draft");

      const result = getDraftPlanIds(dir, "/", "zzz");
      assert.strictEqual(result, null);
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePlanPath
// ---------------------------------------------------------------------------

describe("resolvePlanPath", () => {
  it("resolves plan ID to <outputDir>/<planId>.md", () => {
    const result = resolvePlanPath("my-feature", ".plan", "/home/user/project");
    assert.strictEqual(result, "/home/user/project/.plan/my-feature.md");
  });

  it("passes through path containing /", () => {
    const result = resolvePlanPath("some/nested/plan", ".plan", "/home/user/project");
    assert.strictEqual(result, "/home/user/project/some/nested/plan");
  });

  it("passes through path ending in .md (no /)", () => {
    const result = resolvePlanPath("myplan.md", ".plan", "/home/user/project");
    assert.strictEqual(result, "/home/user/project/myplan.md");
  });

  it("resolves with custom output dir", () => {
    const result = resolvePlanPath("my-feature", "custom-plans", "/home/user/project");
    assert.strictEqual(result, "/home/user/project/custom-plans/my-feature.md");
  });

  it("returns path regardless of file existence", () => {
    const result = resolvePlanPath("nonexistent", ".plan", "/tmp");
    assert.strictEqual(result, "/tmp/.plan/nonexistent.md");
    // No throw — existence check is caller's responsibility
  });
});

// ---------------------------------------------------------------------------
// Draft status validation (handler logic)
// ---------------------------------------------------------------------------

describe("draft status validation", () => {
  it("rejects plan with status: coding", () => {
    const content = "---\nstatus: coding\n---\n# Body";
    const status = parseFrontmatterStatus(content);
    assert.notStrictEqual(status, "draft");
  });

  it("rejects plan with status: ai-attempted", () => {
    const content = "---\nstatus: ai-attempted\n---\n# Body";
    const status = parseFrontmatterStatus(content);
    assert.notStrictEqual(status, "draft");
  });
});

// ---------------------------------------------------------------------------
// buildImplementationPrompt
// ---------------------------------------------------------------------------

describe("buildImplementationPrompt", () => {
  it("includes the plan path", () => {
    const prompt = buildImplementationPrompt("/home/user/.plan/my-feature.md");
    assert.ok(prompt.includes("/home/user/.plan/my-feature.md"));
  });

  it("includes instructions to run tests", () => {
    const prompt = buildImplementationPrompt("plan.md");
    assert.ok(prompt.includes("Tests"));
    assert.ok(prompt.includes("test suite"));
  });

  it("includes subagent review instructions", () => {
    const prompt = buildImplementationPrompt("plan.md");
    assert.ok(prompt.includes("code-review-auditor"));
    assert.ok(prompt.includes("plan-alignment-checker"));
  });

  it("includes completion summary instructions", () => {
    const prompt = buildImplementationPrompt("plan.md");
    assert.ok(prompt.includes("Completion Summary"));
    assert.ok(prompt.includes("What was implemented"));
    assert.ok(prompt.includes("What was NOT implemented"));
  });

  it("does not reference gate loop or iteration counting", () => {
    const prompt = buildImplementationPrompt("plan.md");
    assert.ok(!prompt.includes("iteration"));
    assert.ok(!prompt.includes("gate"));
    assert.ok(!prompt.includes("MAX_GATE"));
  });
});

// ---------------------------------------------------------------------------
// buildSystemPromptAddendum
// ---------------------------------------------------------------------------

describe("buildSystemPromptAddendum", () => {
  it("includes the plan path", () => {
    const addendum = buildSystemPromptAddendum("/home/user/.plan/feature.md");
    assert.ok(addendum.includes("/home/user/.plan/feature.md"));
  });

  it("mentions subagent requirements", () => {
    const addendum = buildSystemPromptAddendum("plan.md");
    assert.ok(addendum.includes("code-review-auditor"));
    assert.ok(addendum.includes("plan-alignment-checker"));
  });

  it("mentions completion summary", () => {
    const addendum = buildSystemPromptAddendum("plan.md");
    assert.ok(addendum.includes("completion summary"));
  });
});
