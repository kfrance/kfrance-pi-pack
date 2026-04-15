import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	buildAnalysisPrompt,
	buildChairmanPrompt,
	buildCouncilPaths,
	buildInitialPrompt,
	buildRevisionPrompt,
	buildSummaryMarkdown,
	listExecutableCandidates,
	participantAnalysisPath,
	participantArtifactPath,
	participantDir,
	participantFinalArtifactPath,
	participantRevisionNotesPath,
	participantSessionDir,
	parseModelListOutput,
	preferPiBinary,
	priorAnalysisPaths,
	priorRevisionNotesPaths,
	resolveModel,
	resolveParticipantModels,
	resolveRunDirPath,
	type AvailableModel,
	type ModelSlot,
} from "./council-lib.ts";

interface CliOptions {
	briefPath: string;
	count: number;
	rounds: number;
	requestedModels?: string[];
	chairmanRequested: string;
	runDir?: string;
	cwd: string;
	piBin: string;
	tools: string[];
	timeoutMs: number;
	maxRetries: number;
}

interface ManifestParticipant {
	slot: ModelSlot;
	requested: string;
	resolved: string;
	dir: string;
	sessionDir: string;
	artifacts: {
		initial: string;
		analyses: string[];
		revisionNotes: string[];
		final: string;
	};
}

interface Manifest {
	version: 1;
	createdAt: string;
	cwd: string;
	briefPath: string;
	runDir: string;
	rounds: number;
	participants: ManifestParticipant[];
	chairman: {
		requested: string;
		resolved: string;
		reportPath: string;
		sessionDir: string;
	};
}

let activeRunStatusPath: string | undefined;

function writeRunStatus(statusPath: string, status: "running" | "completed" | "failed", input: { runDir: string; error?: string } = { runDir: path.dirname(statusPath) }): void {
	writeFileSync(statusPath, JSON.stringify({
		status,
		runDir: input.runDir,
		updatedAt: new Date().toISOString(),
		error: input.error,
	}, null, 2), "utf8");
}

function parseArgs(argv: string[]): CliOptions {
	const options: Partial<CliOptions> = {
		count: 2,
		rounds: 2,
		chairmanRequested: "opus-4.6",
		cwd: process.cwd(),
		piBin: "pi",
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		timeoutMs: 30 * 60 * 1000,
		maxRetries: 1,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const next = argv[index + 1];
		switch (arg) {
			case "--brief":
				options.briefPath = next;
				index++;
				break;
			case "--count":
				options.count = Number(next);
				index++;
				break;
			case "--rounds":
				options.rounds = Number(next);
				index++;
				break;
			case "--models":
				options.requestedModels = next?.split(",").map((item) => item.trim()).filter(Boolean);
				index++;
				break;
			case "--chairman":
				options.chairmanRequested = next;
				index++;
				break;
			case "--run-dir":
				options.runDir = next;
				index++;
				break;
			case "--cwd":
				options.cwd = next;
				index++;
				break;
			case "--pi-bin":
				options.piBin = next;
				index++;
				break;
			case "--tools":
				options.tools = next?.split(",").map((item) => item.trim()).filter(Boolean);
				index++;
				break;
			case "--timeout-ms":
				options.timeoutMs = Number(next);
				index++;
				break;
			case "--max-retries":
				options.maxRetries = Number(next);
				index++;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!options.briefPath) {
		throw new Error("Missing required --brief <path> argument.");
	}
	if (!Number.isInteger(options.count) || (options.count ?? 0) < 2) {
		throw new Error("--count must be an integer >= 2.");
	}
	if (!Number.isInteger(options.rounds) || (options.rounds ?? 0) < 1) {
		throw new Error("--rounds must be an integer >= 1.");
	}
	if (!Number.isInteger(options.timeoutMs) || (options.timeoutMs ?? 0) < 1000) {
		throw new Error("--timeout-ms must be an integer >= 1000.");
	}
	if (!options.tools || options.tools.length === 0) {
		throw new Error("--tools must include at least one tool.");
	}
	if (!Number.isInteger(options.maxRetries) || (options.maxRetries ?? -1) < 0) {
		throw new Error("--max-retries must be an integer >= 0.");
	}
	if (options.requestedModels && options.requestedModels.length < (options.count ?? 0)) {
		throw new Error(`Requested ${options.requestedModels.length} models but count=${options.count}. Provide at least ${options.count} models.`);
	}

	return options as CliOptions;
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function isExecutable(filePath: string): boolean {
	try {
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function tempPromptPath(runDir: string, name: string): string {
	const tempDir = path.join(runDir, "control", "prompts");
	ensureDir(tempDir);
	return path.join(tempDir, `${name}.md`);
}

async function runCommand(input: {
	bin: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; status: number | null }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(input.bin, input.args, {
			cwd: input.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.stdout.destroy();
			child.stderr.destroy();
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 1000);
			reject(new Error(`Command timed out after ${Math.round(input.timeoutMs / 1000)}s: ${input.bin} ${input.args.join(" ")}`));
		}, input.timeoutMs);

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			process.stdout.write(text);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			process.stderr.write(text);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (settled) return;
			settled = true;
			resolve({ stdout, stderr, status });
		});
	});
}

async function runPi(input: {
	piBin: string;
	cwd: string;
	model: string;
	sessionDir: string;
	promptText: string;
	promptName: string;
	runDir: string;
	tools: string[];
	timeoutMs: number;
}): Promise<void> {
	const promptPath = tempPromptPath(input.runDir, input.promptName);
	writeFileSync(promptPath, input.promptText, "utf8");
	ensureDir(input.sessionDir);
	const args = [
		"-p",
		"-c",
		"--session-dir",
		input.sessionDir,
		"--models",
		input.model,
		"--tools",
		input.tools.join(","),
		`@${promptPath}`,
	];
	const result = await runCommand({
		bin: input.piBin,
		args,
		cwd: input.cwd,
		timeoutMs: input.timeoutMs,
	});
	if (result.status !== 0) {
		throw new Error(`pi run failed for ${input.promptName} with exit code ${result.status ?? "unknown"}.`);
	}
}

function ensureExpectedFiles(stageLabel: string, expectedPaths: string[], sessionDir: string, promptName: string): void {
	const missing = expectedPaths.filter((filePath) => !existsSync(filePath));
	if (missing.length === 0) return;
	throw new Error(
		`${stageLabel} did not produce expected files: ${missing.join(", ")}. ` +
		`The runner already reminded the same pi session via '${promptName}'. Session dir: ${sessionDir}`,
	);
}

async function runPiWithRetry(input: {
	piBin: string;
	cwd: string;
	model: string;
	sessionDir: string;
	promptText: string;
	promptName: string;
	runDir: string;
	timeoutMs: number;
	expectedPaths: string[];
	stageLabel: string;
	tools: string[];
	maxRetries: number;
}): Promise<void> {
	for (const filePath of input.expectedPaths) {
		rmSync(filePath, { force: true });
	}
	for (let attempt = 0; attempt <= input.maxRetries; attempt++) {
		const missing = input.expectedPaths.filter((filePath) => !existsSync(filePath));
		if (attempt > 0 && missing.length === 0) return;
		const promptText = attempt === 0
			? input.promptText
			: [
				`Follow-up for ${input.stageLabel}. Continue in the same session.`,
				`Required output files are still missing after retry ${attempt} of ${input.maxRetries}.`,
				"Create every missing required file now before responding.",
				...missing.map((filePath) => `Missing: ${filePath}`),
			].join("\n");
		await runPi({
			...input,
			promptName: attempt === 0 ? input.promptName : `${input.promptName}-retry-${attempt}`,
			promptText,
		});
		if (input.expectedPaths.every((filePath) => existsSync(filePath))) return;
	}
	ensureExpectedFiles(input.stageLabel, input.expectedPaths, input.sessionDir, `${input.promptName}-retry-${input.maxRetries}`);
}

function resolvePiBin(piBin: string, cwd: string): string {
	if (piBin.includes("/") || piBin.includes("\\")) return path.resolve(piBin);
	const candidates = listExecutableCandidates(process.env.PATH, piBin).filter((candidate) => existsSync(candidate) && isExecutable(candidate));
	const resolved = preferPiBinary(candidates, cwd);
	if (!resolved) {
		throw new Error(`Unable to resolve executable '${piBin}' from PATH.`);
	}
	return resolved;
}

function resetRunDirOutputs(paths: ReturnType<typeof buildCouncilPaths>): void {
	rmSync(paths.participantsDir, { recursive: true, force: true });
	rmSync(paths.chairmanDir, { recursive: true, force: true });
	rmSync(paths.controlDir, { recursive: true, force: true });
	for (const filePath of [paths.manifestPath, paths.resolvedModelsPath, paths.summaryPath, paths.runStatusPath]) {
		rmSync(filePath, { force: true });
	}
}

async function listAvailableModels(piBin: string, cwd: string, timeoutMs: number): Promise<AvailableModel[]> {
	const result = await runCommand({
		bin: piBin,
		args: ["--list-models"],
		cwd,
		timeoutMs,
	});
	if (result.status !== 0) {
		throw new Error(`Failed to list models via '${piBin} --list-models': ${result.stderr || result.stdout}`);
	}
	const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
	const models = parseModelListOutput(combinedOutput);
	if (models.length === 0) {
		throw new Error("No models were discovered from 'pi --list-models'.");
	}
	return models;
}

function createRunDir(cwd: string, baseDir?: string): string {
	const resolvedBaseDir = resolveRunDirPath(cwd, baseDir);
	if (resolvedBaseDir) {
		ensureDir(resolvedBaseDir);
		return resolvedBaseDir;
	}
	const root = path.join(cwd, "skills", "council", "runs");
	ensureDir(root);
	return mkdtempSync(path.join(root, "run-"));
}

function writeManifest(manifestPath: string, manifest: Manifest): void {
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

async function runParticipantInitialStage(options: CliOptions, runDir: string, taskPath: string, participants: ReturnType<typeof resolveParticipantModels>): Promise<void> {
	await Promise.all(participants.map(async (participant) => {
		console.log(`[council] Initial artifact: participant ${participant.slot} (${participant.resolved})`);
		await runPiWithRetry({
			piBin: options.piBin,
			cwd: options.cwd,
			model: participant.resolved,
			sessionDir: participantSessionDir(runDir, participant.slot),
			promptName: `${participant.slot.toLowerCase()}-initial`,
			runDir,
			tools: options.tools,
			promptText: buildInitialPrompt({
				taskPath,
				outputPath: participantArtifactPath(runDir, participant.slot, 1),
				slot: participant.slot,
				model: participant.resolved,
			}),
			timeoutMs: options.timeoutMs,
			expectedPaths: [participantArtifactPath(runDir, participant.slot, 1)],
			stageLabel: `initial artifact for participant ${participant.slot}`,
			maxRetries: options.maxRetries,
		});
	}));
}

async function runParticipantAnalysisStage(options: CliOptions, runDir: string, taskPath: string, cycle: number, participants: ReturnType<typeof resolveParticipantModels>): Promise<void> {
	await Promise.all(participants.map(async (participant) => {
		const currentArtifact = cycle === 1
			? participantArtifactPath(runDir, participant.slot, 1)
			: participantArtifactPath(runDir, participant.slot, cycle);
		const peerArtifacts = participants
			.filter((peer) => peer.slot !== participant.slot)
			.map((peer) => cycle === 1
				? participantArtifactPath(runDir, peer.slot, 1)
				: participantArtifactPath(runDir, peer.slot, cycle));
		const priorPeerAnalyses = participants
			.filter((peer) => peer.slot !== participant.slot)
			.flatMap((peer) => priorAnalysisPaths(runDir, peer.slot, cycle - 1));
		const priorPeerRevisionNotes = participants
			.filter((peer) => peer.slot !== participant.slot)
			.flatMap((peer) => priorRevisionNotesPaths(runDir, peer.slot, cycle - 1));
		console.log(`[council] Analysis r${cycle}: participant ${participant.slot} (${participant.resolved})`);
		await runPiWithRetry({
			piBin: options.piBin,
			cwd: options.cwd,
			model: participant.resolved,
			sessionDir: participantSessionDir(runDir, participant.slot),
			promptName: `${participant.slot.toLowerCase()}-analysis-r${cycle}`,
			runDir,
			tools: options.tools,
			promptText: buildAnalysisPrompt({
				taskPath,
				selfArtifactPath: currentArtifact,
				peerArtifactPaths: peerArtifacts,
				priorPeerAnalysisPaths: priorPeerAnalyses,
				priorPeerRevisionNotesPaths: priorPeerRevisionNotes,
				outputPath: participantAnalysisPath(runDir, participant.slot, cycle),
				slot: participant.slot,
				cycle,
				model: participant.resolved,
			}),
			timeoutMs: options.timeoutMs,
			expectedPaths: [participantAnalysisPath(runDir, participant.slot, cycle)],
			stageLabel: `analysis r${cycle} for participant ${participant.slot}`,
			maxRetries: options.maxRetries,
		});
	}));
}

async function runParticipantRevisionStage(options: CliOptions, runDir: string, taskPath: string, cycle: number, participants: ReturnType<typeof resolveParticipantModels>): Promise<void> {
	await Promise.all(participants.map(async (participant) => {
		const currentArtifact = cycle === 1
			? participantArtifactPath(runDir, participant.slot, 1)
			: participantArtifactPath(runDir, participant.slot, cycle);
		const outputArtifactPath = cycle === options.rounds
			? participantFinalArtifactPath(runDir, participant.slot)
			: participantArtifactPath(runDir, participant.slot, cycle + 1);
		console.log(`[council] Revision r${cycle}: participant ${participant.slot} (${participant.resolved})`);
		await runPiWithRetry({
			piBin: options.piBin,
			cwd: options.cwd,
			model: participant.resolved,
			sessionDir: participantSessionDir(runDir, participant.slot),
			promptName: `${participant.slot.toLowerCase()}-revision-r${cycle}`,
			runDir,
			tools: options.tools,
			promptText: buildRevisionPrompt({
				taskPath,
				currentArtifactPath: currentArtifact,
				analysisPath: participantAnalysisPath(runDir, participant.slot, cycle),
				outputArtifactPath,
				revisionNotesPath: participantRevisionNotesPath(runDir, participant.slot, cycle),
				slot: participant.slot,
				cycle,
				model: participant.resolved,
				isFinal: cycle === options.rounds,
			}),
			timeoutMs: options.timeoutMs,
			expectedPaths: [outputArtifactPath, participantRevisionNotesPath(runDir, participant.slot, cycle)],
			stageLabel: `revision r${cycle} for participant ${participant.slot}`,
			maxRetries: options.maxRetries,
		});
	}));
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	options.cwd = path.resolve(options.cwd);
	options.piBin = resolvePiBin(options.piBin, options.cwd);
	const runDir = createRunDir(options.cwd, options.runDir);
	const paths = buildCouncilPaths(runDir);
	activeRunStatusPath = paths.runStatusPath;

	const sourceBrief = path.resolve(options.briefPath);
	if (!existsSync(sourceBrief)) {
		throw new Error(`Brief file not found: ${sourceBrief}`);
	}
	const briefContent = readFileSync(sourceBrief, "utf8");
	resetRunDirOutputs(paths);
	for (const dir of [paths.inputDir, paths.participantsDir, paths.chairmanDir, paths.controlDir]) {
		ensureDir(dir);
	}
	writeFileSync(paths.taskPath, briefContent, "utf8");
	writeRunStatus(paths.runStatusPath, "running", { runDir });

	const availableModels = await listAvailableModels(options.piBin, options.cwd, options.timeoutMs);
	const participants = resolveParticipantModels(availableModels, options.count, options.requestedModels);
	const chairmanResolved = resolveModel(options.chairmanRequested, availableModels);
	if (!chairmanResolved) {
		throw new Error(`Unable to resolve chairman model '${options.chairmanRequested}'.`);
	}
	writeFileSync(paths.resolvedModelsPath, JSON.stringify({ participants, chairman: chairmanResolved }, null, 2), "utf8");

	const manifest: Manifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		cwd: options.cwd,
		briefPath: paths.taskPath,
		runDir,
		rounds: options.rounds,
		participants: participants.map((participant) => ({
			slot: participant.slot,
			requested: participant.requested,
			resolved: participant.resolved,
			dir: participantDir(runDir, participant.slot),
			sessionDir: participantSessionDir(runDir, participant.slot),
			artifacts: {
				initial: participantArtifactPath(runDir, participant.slot, 1),
				analyses: Array.from({ length: options.rounds }, (_, i) => participantAnalysisPath(runDir, participant.slot, i + 1)),
				revisionNotes: Array.from({ length: options.rounds }, (_, i) => participantRevisionNotesPath(runDir, participant.slot, i + 1)),
				final: participantFinalArtifactPath(runDir, participant.slot),
			},
		})),
		chairman: {
			requested: options.chairmanRequested,
			resolved: chairmanResolved,
			reportPath: paths.chairmanReportPath,
			sessionDir: path.join(paths.chairmanDir, "session"),
		},
	};
	writeManifest(paths.manifestPath, manifest);

	await runParticipantInitialStage(options, runDir, paths.taskPath, participants);
	for (let cycle = 1; cycle <= options.rounds; cycle++) {
		await runParticipantAnalysisStage(options, runDir, paths.taskPath, cycle, participants);
		await runParticipantRevisionStage(options, runDir, paths.taskPath, cycle, participants);
	}

	const allAnalysisPaths = participants.flatMap((participant) =>
		Array.from({ length: options.rounds }, (_, i) => participantAnalysisPath(runDir, participant.slot, i + 1)),
	);
	const allRevisionNotePaths = participants.flatMap((participant) =>
		Array.from({ length: options.rounds }, (_, i) => participantRevisionNotesPath(runDir, participant.slot, i + 1)),
	);

	if (existsSync(manifest.chairman.sessionDir)) {
		rmSync(manifest.chairman.sessionDir, { recursive: true, force: true });
	}
	console.log(`[council] Chairman synthesis (${chairmanResolved})`);
	await runPiWithRetry({
		piBin: options.piBin,
		cwd: options.cwd,
		model: chairmanResolved,
		sessionDir: manifest.chairman.sessionDir,
		promptName: "chairman",
		runDir,
		tools: options.tools,
		promptText: buildChairmanPrompt({
			taskPath: paths.taskPath,
			finalArtifactPaths: participants.map((participant) => participantFinalArtifactPath(runDir, participant.slot)),
			analysisPaths: allAnalysisPaths,
			revisionNotesPaths: allRevisionNotePaths,
			reportPath: paths.chairmanReportPath,
			model: chairmanResolved,
		}),
		timeoutMs: options.timeoutMs,
		expectedPaths: [paths.chairmanReportPath],
		stageLabel: "chairman synthesis",
		maxRetries: options.maxRetries,
	});

	writeFileSync(paths.summaryPath, buildSummaryMarkdown({
		runDir,
		taskPath: paths.taskPath,
		participants,
		rounds: options.rounds,
		chairman: chairmanResolved,
		chairmanReportPath: paths.chairmanReportPath,
	}), "utf8");

	console.log(`\nCouncil run complete.`);
	console.log(`Run directory: ${runDir}`);
	console.log(`Summary: ${paths.summaryPath}`);
	console.log(`Chairman report: ${paths.chairmanReportPath}`);
	writeRunStatus(paths.runStatusPath, "completed", { runDir });
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (activeRunStatusPath) {
		writeRunStatus(activeRunStatusPath, "failed", { runDir: path.dirname(activeRunStatusPath), error: message });
	}
	console.error(`Council runner failed: ${message}`);
	process.exit(1);
}
