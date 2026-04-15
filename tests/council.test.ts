import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
	buildAnalysisPrompt,
	buildChairmanPrompt,
	buildCouncilPaths,
	buildInitialPrompt,
	buildRevisionPrompt,
	listExecutableCandidates,
	parseModelListOutput,
	participantFinalArtifactPath,
	preferPiBinary,
	priorRevisionNotesPaths,
	resolveModel,
	resolveParticipantModels,
	resolveRunDirPath,
	splitPathEntries,
} from "../skills/council/scripts/council-lib.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("council runner helpers", () => {
	it("parses pi --list-models output into provider/model ids", () => {
		const models = parseModelListOutput(`provider      model\npi-cc-router  claude-opus-4-6\nopenai-codex  gpt-5.4\n`);
		assert.deepEqual(models, [
			{ provider: "pi-cc-router", id: "claude-opus-4-6", fullId: "pi-cc-router/claude-opus-4-6" },
			{ provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
		]);
	});

	it("parses model lines even with ANSI escape codes", () => {
		const models = parseModelListOutput(`provider      model\n\u001b[32mopenai-codex\u001b[0m  gpt-5.4\n`);
		assert.deepEqual(models, [
			{ provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
		]);
	});

	it("parses model lines with variable whitespace and trailing columns", () => {
		const models = parseModelListOutput(`provider model context max-out\nopenai-codex gpt-5.4 272K 128K\nopenrouter    google/gemini-3.1-pro-preview    1M   64K\n`);
		assert.deepEqual(models, [
			{ provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
			{ provider: "openrouter", id: "google/gemini-3.1-pro-preview", fullId: "openrouter/google/gemini-3.1-pro-preview" },
		]);
	});

	it("resolves default aliases to exact preferred models", () => {
		const available = parseModelListOutput(`provider      model\npi-cc-router  claude-opus-4-6\nopenai-codex  gpt-5.4\nopenrouter    google/gemini-3.1-pro-preview\nopenrouter    x-ai/grok-4.20\n`);
		assert.equal(resolveModel("opus-4.6", available), "pi-cc-router/claude-opus-4-6");
		assert.equal(resolveModel("grok-4.2", available), "openrouter/x-ai/grok-4.20");
	});

	it("resolves participant defaults for requested count", () => {
		const available = parseModelListOutput(`provider      model\npi-cc-router  claude-opus-4-6\nopenai-codex  gpt-5.4\nopenrouter    google/gemini-3.1-pro-preview\n`);
		const resolved = resolveParticipantModels(available, 2);
		assert.deepEqual(resolved, [
			{ slot: "A", requested: "opus-4.6", resolved: "pi-cc-router/claude-opus-4-6" },
			{ slot: "B", requested: "gpt-5.4", resolved: "openai-codex/gpt-5.4" },
		]);
	});

	it("builds predictable council paths", () => {
		const paths = buildCouncilPaths("/tmp/council/run-1");
		assert.equal(paths.taskPath, "/tmp/council/run-1/input/task.md");
		assert.equal(paths.chairmanReportPath, "/tmp/council/run-1/chairman/chairman-report.md");
		assert.equal(participantFinalArtifactPath("/tmp/council/run-1", "A"), "/tmp/council/run-1/participants/A/artifact-final.md");
	});

	it("resolves explicit run-dir relative to --cwd", () => {
		assert.equal(resolveRunDirPath("/workspace/project", "skills/council/runs/demo"), "/workspace/project/skills/council/runs/demo");
		assert.equal(resolveRunDirPath("/workspace/project", "/tmp/demo"), "/tmp/demo");
	});

	it("splits PATH entries and enumerates executable candidates", () => {
		const pathValue = "/one:/two:/three";
		assert.deepEqual(splitPathEntries(pathValue), ["/one", "/two", "/three"]);
		assert.deepEqual(listExecutableCandidates(pathValue, "pi"), ["/one/pi", "/two/pi", "/three/pi"]);
	});

	it("prefers non-node_modules pi binaries over local shims", () => {
		const selected = preferPiBinary([
			"/repo/node_modules/.bin/pi",
			"/home/kfrance/.npm-global/bin/pi",
		], "/repo");
		assert.equal(selected, "/home/kfrance/.npm-global/bin/pi");
	});

	it("builds prompts that instruct pi runs to write their own files", () => {
		const initial = buildInitialPrompt({
			taskPath: "/run/input/task.md",
			outputPath: "/run/participants/A/artifact-r1.md",
			slot: "A",
			model: "pi-cc-router/claude-opus-4-6",
		});
		assert.match(initial, /Write the complete artifact to this exact path:/);
		assert.match(initial, /Use the write tool to create or overwrite that file/);

		const analysis = buildAnalysisPrompt({
			taskPath: "/run/input/task.md",
			selfArtifactPath: "/run/participants/A/artifact-r1.md",
			peerArtifactPaths: ["/run/participants/B/artifact-r1.md"],
			priorPeerAnalysisPaths: ["/run/participants/B/analysis-r1.md"],
			priorPeerRevisionNotesPaths: ["/run/participants/B/revision-notes-r1.md"],
			outputPath: "/run/participants/A/analysis-r2.md",
			slot: "A",
			cycle: 2,
			model: "pi-cc-router/claude-opus-4-6",
		});
		assert.match(analysis, /approach to doing a good comparative review/i);
		assert.match(analysis, /other participants' current artifacts/i);
		assert.match(analysis, /accepted or rejected/i);

		const revision = buildRevisionPrompt({
			taskPath: "/run/input/task.md",
			currentArtifactPath: "/run/participants/A/artifact-r2.md",
			analysisPath: "/run/participants/A/analysis-r2.md",
			outputArtifactPath: "/run/participants/A/artifact-final.md",
			revisionNotesPath: "/run/participants/A/revision-notes-r2.md",
			slot: "A",
			cycle: 2,
			model: "pi-cc-router/claude-opus-4-6",
			isFinal: true,
		});
		assert.match(revision, /You must create TWO files:/);
		assert.match(revision, /feedback rejected and why/);

		const chairman = buildChairmanPrompt({
			taskPath: "/run/input/task.md",
			finalArtifactPaths: ["/run/participants/A/artifact-final.md", "/run/participants/B/artifact-final.md"],
			analysisPaths: ["/run/participants/A/analysis-r1.md", "/run/participants/B/analysis-r1.md"],
			revisionNotesPaths: ["/run/participants/A/revision-notes-r1.md", "/run/participants/B/revision-notes-r1.md"],
			reportPath: "/run/chairman/chairman-report.md",
			model: "pi-cc-router/claude-opus-4-6",
		});
		assert.match(chairman, /# Final Artifact/);
		assert.match(chairman, /# Key Corrections Made During Council/);
		assert.match(chairman, /# Participant Contribution Breakdown/);
		assert.match(chairman, /# Participant Ranking/);
		assert.match(chairman, /Base the ranking on actual contribution quality and impact on the final artifact/);
	});

	it("builds prior revision note paths for completed cycles", () => {
		assert.deepEqual(priorRevisionNotesPaths("/run", "B", 2), [
			"/run/participants/B/revision-notes-r1.md",
			"/run/participants/B/revision-notes-r2.md",
		]);
	});

	it("runs a smoke-test council flow with retries and run-dir reset", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "council-runner-"));
		tempDirs.push(tempRoot);
		const fakePiPath = path.join(tempRoot, "fake-pi.js");
		const attemptsDir = path.join(tempRoot, "attempts");
		const projectCwd = path.join(tempRoot, "workspace");
		const runDirRelative = path.join("skills", "council", "runs", "smoke");
		const runDirAbsolute = path.join(projectCwd, runDirRelative);
		const briefPath = path.join(tempRoot, "brief.md");
		writeFileSync(briefPath, "# brief\nreview the council runner\n", "utf8");
		writeFileSync(path.join(tempRoot, "stale.txt"), "stale", "utf8");
		writeFileSync(fakePiPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const attemptsDir = process.env.FAKE_PI_ATTEMPTS_DIR;
const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS || '0');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ensureDir = (filePath) => fs.mkdirSync(path.dirname(filePath), { recursive: true });
const markerPath = (promptName) => path.join(attemptsDir, promptName + '.txt');
const timingPath = (promptName, suffix) => path.join(attemptsDir, promptName + '.' + suffix + '.txt');
const countPromptAttempt = (promptName) => {
  ensureDir(markerPath(promptName));
  const count = fs.existsSync(markerPath(promptName)) ? Number(fs.readFileSync(markerPath(promptName), 'utf8')) : 0;
  fs.writeFileSync(markerPath(promptName), String(count + 1), 'utf8');
  return count + 1;
};
const writeOutputFiles = (promptText) => {
  const matches = [];
  const one = promptText.match(new RegExp('Write the complete artifact to this exact path:\\n\\n([^\\n]+)'));
  if (one) matches.push(one[1]);
  const two = promptText.match(new RegExp('Write the analysis to this exact path:\\n\\n([^\\n]+)'));
  if (two) matches.push(two[1]);
  const rev = promptText.match(new RegExp('1\\. Updated artifact at: ([^\\n]+)\\n\\n2\\. Revision notes at: ([^\\n]+)'));
  if (rev) { matches.push(rev[1], rev[2]); }
  const chair = promptText.match(new RegExp('Write a chairman report to this exact path:\\n\\n([^\\n]+)'));
  if (chair) matches.push(chair[1]);
  for (const line of promptText.split(/\\n/)) {
    const missing = line.match(/^Missing: (.+)$/);
    if (missing) matches.push(missing[1]);
  }
  for (const filePath of matches) {
    ensureDir(filePath);
    fs.writeFileSync(filePath, '# generated\\n' + path.basename(filePath) + '\\n', 'utf8');
  }
};
(async () => {
  if (args[0] === '--list-models') {
    process.stderr.write('provider      model\\n');
    process.stderr.write('pi-cc-router  claude-opus-4-6\\n');
    process.stderr.write('openai-codex  gpt-5.4\\n');
    process.exit(0);
  }
  const toolsIndex = args.indexOf('--tools');
  if (toolsIndex === -1 || !args[toolsIndex + 1] || !args[toolsIndex + 1].includes('bash')) {
    console.error('expected --tools with bash enabled');
    process.exit(1);
  }
  const promptArg = args.find((arg) => arg.startsWith('@'));
  const promptPath = promptArg.slice(1);
  const promptName = path.basename(promptPath, '.md');
  const promptText = fs.readFileSync(promptPath, 'utf8');
  const attempt = countPromptAttempt(promptName);
  fs.writeFileSync(timingPath(promptName, 'start'), String(Date.now()), 'utf8');
  await wait(sleepMs);
  if (promptName === 'a-initial' && attempt === 1) {
    process.stdout.write('skipping first write intentionally\\n');
    process.exit(0);
  }
  writeOutputFiles(promptText);
  fs.writeFileSync(timingPath(promptName, 'end'), String(Date.now()), 'utf8');
  process.exit(0);
})().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
`, "utf8");
		chmodSync(fakePiPath, 0o755);
		const staleDir = path.join(runDirAbsolute, "participants", "A");
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(path.join(staleDir, "old.txt"), "old", "utf8");
		const result = spawnSync("npx", [
			"tsx",
			"./skills/council/scripts/run-council.ts",
			"--brief", briefPath,
			"--cwd", projectCwd,
			"--run-dir", runDirRelative,
			"--count", "2",
			"--rounds", "1",
			"--pi-bin", fakePiPath,
			"--max-retries", "2",
			"--timeout-ms", "5000",
		], {
			cwd: path.resolve("."),
			encoding: "utf8",
			env: {
				...process.env,
				FAKE_PI_ATTEMPTS_DIR: attemptsDir,
				FAKE_PI_SLEEP_MS: "250",
			},
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(existsSync(path.join(runDirAbsolute, "participants", "A", "old.txt")), false);
		assert.equal(existsSync(path.join(runDirAbsolute, "participants", "A", "artifact-r1.md")), true);
		assert.equal(existsSync(path.join(runDirAbsolute, "participants", "A", "artifact-final.md")), true);
		assert.equal(existsSync(path.join(runDirAbsolute, "chairman", "chairman-report.md")), true);
		assert.equal(existsSync(path.join(runDirAbsolute, "run-status.json")), true);
		assert.match(readFileSync(path.join(runDirAbsolute, "run-status.json"), "utf8"), /"status": "completed"/);
		assert.equal(readFileSync(path.join(attemptsDir, "a-initial.txt"), "utf8"), "1");
		const retryPromptName = "a-initial-retry-1.txt";
		assert.equal(readFileSync(path.join(attemptsDir, retryPromptName), "utf8"), "1");
		const aStart = Number(readFileSync(path.join(attemptsDir, "a-initial.start.txt"), "utf8"));
		const bStart = Number(readFileSync(path.join(attemptsDir, "b-initial.start.txt"), "utf8"));
		assert.ok(Math.abs(aStart - bStart) < 200, `expected near-simultaneous initial starts, got ${aStart} vs ${bStart}`);
	});
});
