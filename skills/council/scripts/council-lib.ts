import path from "node:path";

const NODE_MODULES_BIN_PATTERN = /[\\/]node_modules[\\/]\.bin[\\/]/;

export const MODEL_SLOTS = ["A", "B", "C", "D", "E", "F"] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

export interface AvailableModel {
	provider: string;
	id: string;
	fullId: string;
}

export interface ParticipantModel {
	slot: ModelSlot;
	requested: string;
	resolved: string;
}

export interface CouncilPaths {
	runDir: string;
	inputDir: string;
	participantsDir: string;
	chairmanDir: string;
	controlDir: string;
	manifestPath: string;
	taskPath: string;
	resolvedModelsPath: string;
	summaryPath: string;
	runStatusPath: string;
	chairmanReportPath: string;
}

const SLOT_DEFAULT_ALIASES: Record<ModelSlot, string> = {
	A: "opus-4.6",
	B: "gpt-5.4",
	C: "gemini-3.1-pro-preview",
	D: "grok-4.2",
	E: "glm-5.1",
	F: "minimax-2.7",
};

const MODEL_ALIASES: Record<string, string[]> = {
	"opus-4.6": ["pi-cc-router/claude-opus-4-6"],
	"claude-opus-4-6": ["pi-cc-router/claude-opus-4-6"],
	"gpt-5.4": ["openai-codex/gpt-5.4"],
	"openai-codex-gpt-5.4": ["openai-codex/gpt-5.4"],
	"gemini-3.1-pro-preview": ["openrouter/google/gemini-3.1-pro-preview"],
	"grok-4.2": ["openrouter/x-ai/grok-4.20", "openrouter/x-ai/grok-4.2", "openrouter/x-ai/grok-4"],
	"glm-5.1": ["openrouter/z-ai/glm-5.1"],
	"minimax-2.7": ["openrouter/minimax/minimax-m2.7"],
};

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function normalize(value: string): string {
	return stripAnsi(value).trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function resolveRunDirPath(cwd: string, baseDir?: string): string | undefined {
	if (!baseDir) return undefined;
	return path.isAbsolute(baseDir) ? path.resolve(baseDir) : path.resolve(cwd, baseDir);
}

export function splitPathEntries(pathValue: string | undefined): string[] {
	if (!pathValue) return [];
	return pathValue
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function listExecutableCandidates(pathValue: string | undefined, executableName: string): string[] {
	const executableNames = process.platform === "win32"
		? [executableName, `${executableName}.cmd`, `${executableName}.exe`, `${executableName}.bat`]
		: [executableName];
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const entry of splitPathEntries(pathValue)) {
		for (const name of executableNames) {
			const candidate = path.join(entry, name);
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			candidates.push(candidate);
		}
	}
	return candidates;
}

export function preferPiBinary(candidates: string[], cwd: string): string | undefined {
	const scored = candidates.map((candidate, index) => {
		const resolved = path.resolve(candidate);
		const inNodeModulesBin = NODE_MODULES_BIN_PATTERN.test(resolved);
		const inCurrentProject = resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`);
		let score = 0;
		if (!inNodeModulesBin) score += 100;
		if (!inCurrentProject) score += 10;
		return { candidate: resolved, index, score };
	});
	if (scored.length === 0) return undefined;
	const best = scored.sort((a, b) => b.score - a.score || a.index - b.index)[0]!;
	return best.candidate;
}

export function parseModelListOutput(output: string): AvailableModel[] {
	const models: AvailableModel[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const cleanLine = stripAnsi(rawLine);
		const line = cleanLine.trim();
		if (!line || line.startsWith("provider") || line.startsWith("-")) continue;
		const columns = line.split(/\s+/).filter(Boolean);
		if (columns.length < 2) continue;
		const [provider, id] = columns;
		if (!provider || !id) continue;
		models.push({ provider, id, fullId: `${provider}/${id}` });
	}
	return models;
}

export function getDefaultRequestedModels(count: number): string[] {
	return MODEL_SLOTS.slice(0, count).map((slot) => SLOT_DEFAULT_ALIASES[slot]);
}

export function resolveModel(requested: string, available: AvailableModel[]): string | undefined {
	const raw = requested.trim();
	if (!raw) return undefined;
	const normalized = normalize(raw);
	const byFullId = available.find((model) => normalize(model.fullId) === normalized);
	if (byFullId) return byFullId.fullId;

	const aliasCandidates = MODEL_ALIASES[normalized] ?? [];
	for (const candidate of aliasCandidates) {
		const found = available.find((model) => model.fullId === candidate);
		if (found) return found.fullId;
	}

	const byExactId = available.filter((model) => normalize(model.id) === normalized);
	if (byExactId.length === 1) return byExactId[0]!.fullId;
	if (byExactId.length > 1) {
		const preferred = aliasCandidates
			.map((candidate) => byExactId.find((model) => model.fullId === candidate))
			.find(Boolean);
		if (preferred) return preferred.fullId;
		return byExactId[0]!.fullId;
	}

	const fuzzy = available.find((model) => {
		const full = normalize(model.fullId);
		const id = normalize(model.id);
		return full.includes(normalized) || id.includes(normalized);
	});
	return fuzzy?.fullId;
}

export function resolveParticipantModels(
	available: AvailableModel[],
	count: number,
	requestedModels?: string[],
): ParticipantModel[] {
	const requested = requestedModels && requestedModels.length > 0
		? requestedModels
		: getDefaultRequestedModels(count);

	if (requested.length < count) {
		throw new Error(`Requested ${requested.length} models but count=${count}. Provide at least ${count} models.`);
	}
	if (count > MODEL_SLOTS.length) {
		throw new Error(`count=${count} exceeds supported maximum of ${MODEL_SLOTS.length}.`);
	}

	return MODEL_SLOTS.slice(0, count).map((slot, index) => {
		const modelRequest = requested[index]!;
		const resolved = resolveModel(modelRequest, available);
		if (!resolved) {
			throw new Error(`Unable to resolve requested model '${modelRequest}'. Run 'pi --list-models' and choose an available model.`);
		}
		return { slot, requested: modelRequest, resolved };
	});
}

export function buildCouncilPaths(runDir: string): CouncilPaths {
	return {
		runDir,
		inputDir: path.join(runDir, "input"),
		participantsDir: path.join(runDir, "participants"),
		chairmanDir: path.join(runDir, "chairman"),
		controlDir: path.join(runDir, "control"),
		manifestPath: path.join(runDir, "manifest.json"),
		taskPath: path.join(runDir, "input", "task.md"),
		resolvedModelsPath: path.join(runDir, "resolved-models.json"),
		summaryPath: path.join(runDir, "summary.md"),
		runStatusPath: path.join(runDir, "run-status.json"),
		chairmanReportPath: path.join(runDir, "chairman", "chairman-report.md"),
	};
}

export function participantDir(runDir: string, slot: ModelSlot): string {
	return path.join(runDir, "participants", slot);
}

export function participantSessionDir(runDir: string, slot: ModelSlot): string {
	return path.join(participantDir(runDir, slot), "session");
}

export function participantArtifactPath(runDir: string, slot: ModelSlot, cycle: number): string {
	return path.join(participantDir(runDir, slot), `artifact-r${cycle}.md`);
}

export function participantAnalysisPath(runDir: string, slot: ModelSlot, cycle: number): string {
	return path.join(participantDir(runDir, slot), `analysis-r${cycle}.md`);
}

export function participantRevisionNotesPath(runDir: string, slot: ModelSlot, cycle: number): string {
	return path.join(participantDir(runDir, slot), `revision-notes-r${cycle}.md`);
}

export function participantFinalArtifactPath(runDir: string, slot: ModelSlot): string {
	return path.join(participantDir(runDir, slot), "artifact-final.md");
}

export function priorAnalysisPaths(runDir: string, slot: ModelSlot, completedCycles: number): string[] {
	const paths: string[] = [];
	for (let cycle = 1; cycle <= completedCycles; cycle++) {
		paths.push(participantAnalysisPath(runDir, slot, cycle));
	}
	return paths;
}

export function priorRevisionNotesPaths(runDir: string, slot: ModelSlot, completedCycles: number): string[] {
	const paths: string[] = [];
	for (let cycle = 1; cycle <= completedCycles; cycle++) {
		paths.push(participantRevisionNotesPath(runDir, slot, cycle));
	}
	return paths;
}

function quotePaths(paths: string[]): string {
	return paths.map((item) => `- ${item}`).join("\n");
}

export function buildInitialPrompt(input: {
	taskPath: string;
	outputPath: string;
	slot: ModelSlot;
	model: string;
}): string {
	return [
		`You are council participant ${input.slot} using model ${input.model}.`,
		`Read the task brief at: ${input.taskPath}`,
		"Produce an independent first-pass artifact for the task.",
		"Do not mention hidden chain-of-thought. Keep reasoning visible only through concise, explicit sections.",
		"Write the complete artifact to this exact path:",
		input.outputPath,
		"Use the write tool to create or overwrite that file.",
		"After writing the file, respond briefly with what you produced and the path.",
	].join("\n\n");
}

export function buildAnalysisPrompt(input: {
	taskPath: string;
	selfArtifactPath: string;
	peerArtifactPaths: string[];
	priorPeerAnalysisPaths: string[];
	priorPeerRevisionNotesPaths: string[];
	outputPath: string;
	slot: ModelSlot;
	cycle: number;
	model: string;
}): string {
	const priorAnalysisSection = input.priorPeerAnalysisPaths.length > 0
		? `Also read these prior peer analyses before writing your analysis:\n${quotePaths(input.priorPeerAnalysisPaths)}`
		: "This is the first analysis cycle, so there are no prior analyses to read.";
	const priorRevisionNotesSection = input.priorPeerRevisionNotesPaths.length > 0
		? `Also read these prior peer revision notes so you can see what feedback was accepted or rejected:\n${quotePaths(input.priorPeerRevisionNotesPaths)}`
		: "There are no prior peer revision notes yet.";

	return [
		`You are council participant ${input.slot} using model ${input.model}. This is analysis cycle ${input.cycle}.`,
		`Read the task brief at: ${input.taskPath}`,
		`Read your current artifact at: ${input.selfArtifactPath}`,
		`Read the other participants' current artifacts:\n${quotePaths(input.peerArtifactPaths)}`,
		priorAnalysisSection,
		priorRevisionNotesSection,
		"Write an analysis that starts by explaining your approach to doing a good comparative review, then covers:",
		"- strongest ideas from peers",
		"- weaknesses or blind spots",
		"- where peers may be wrong or incomplete",
		"- what feedback should change your own artifact",
		"Write the analysis to this exact path:",
		input.outputPath,
		"Use the write tool to create or overwrite that file.",
		"After writing the file, respond briefly with the path and the biggest correction you surfaced.",
	].join("\n\n");
}

export function buildRevisionPrompt(input: {
	taskPath: string;
	currentArtifactPath: string;
	analysisPath: string;
	outputArtifactPath: string;
	revisionNotesPath: string;
	slot: ModelSlot;
	cycle: number;
	model: string;
	isFinal: boolean;
}): string {
	return [
		`You are council participant ${input.slot} using model ${input.model}. This is revision cycle ${input.cycle}.`,
		`Read the task brief at: ${input.taskPath}`,
		`Read your current artifact at: ${input.currentArtifactPath}`,
		`Read your latest analysis at: ${input.analysisPath}`,
		input.isFinal
			? "Produce your final artifact after incorporating the best feedback."
			: "Revise your artifact using the feedback you consider valid.",
		"You must create TWO files:",
		`1. Updated artifact at: ${input.outputArtifactPath}`,
		`2. Revision notes at: ${input.revisionNotesPath}`,
		"The revision notes must briefly list:",
		"- key changes made",
		"- feedback accepted",
		"- feedback rejected and why",
		"Use the write tool to create or overwrite both files.",
		"After writing the files, respond briefly with both paths and the most important correction you adopted.",
	].join("\n\n");
}

export function buildChairmanPrompt(input: {
	taskPath: string;
	finalArtifactPaths: string[];
	analysisPaths: string[];
	revisionNotesPaths: string[];
	reportPath: string;
	model: string;
}): string {
	return [
		`You are the chairman for this council run using model ${input.model}.`,
		"This is a fresh synthesis pass. Do not assume any prior participant identity.",
		`Read the task brief at: ${input.taskPath}`,
		`Read the participants' final artifacts:\n${quotePaths(input.finalArtifactPaths)}`,
		`Read the analyses produced during the council:\n${quotePaths(input.analysisPaths)}`,
		`Read the revision notes:\n${quotePaths(input.revisionNotesPaths)}`,
		"Write a chairman report to this exact path:",
		input.reportPath,
		"The chairman report must contain these top-level sections:",
		"# Final Artifact",
		"# Key Corrections Made During Council",
		"# Participant Contribution Breakdown",
		"# Participant Ranking",
		"# Important Disagreements or Minority Views",
		"# Open Questions or Residual Risks",
		"In '# Participant Contribution Breakdown', include one subsection per participant (for example, '## A') that explains:",
		"- that participant's strongest ideas or corrections",
		"- where that participant materially improved the final result",
		"- any notable weaknesses, misses, or low-value feedback",
		"In '# Participant Ranking', rank every participant from strongest to weakest contribution for this specific run and explain why each rank was earned.",
		"Base the ranking on actual contribution quality and impact on the final artifact, not on model reputation.",
		"Use the write tool to create or overwrite the report.",
		"After writing the file, respond briefly with the report path and the most important correction the council made.",
	].join("\n\n");
}

export function buildSummaryMarkdown(input: {
	runDir: string;
	taskPath: string;
	participants: ParticipantModel[];
	rounds: number;
	chairman: string;
	chairmanReportPath: string;
}): string {
	const participantLines = input.participants.map((participant) => {
		const finalPath = participantFinalArtifactPath(input.runDir, participant.slot);
		return `- ${participant.slot}: ${participant.resolved}\n  - final artifact: ${finalPath}`;
	}).join("\n");

	return [
		"# Council Run Summary",
		"",
		`- Run directory: ${input.runDir}`,
		`- Task brief: ${input.taskPath}`,
		`- Rounds: ${input.rounds}`,
		`- Chairman: ${input.chairman}`,
		`- Chairman report: ${input.chairmanReportPath}`,
		"",
		"## Participants",
		participantLines,
		"",
		"## Notes",
		"- Each participant kept its own pi session across rounds.",
		"- The chairman ran in a fresh session.",
		"- Key corrections, participant contributions, rankings, and disagreements should be read from the chairman report.",
	].join("\n");
}
