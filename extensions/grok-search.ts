import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

export const TOOL_NAME = "grok_search";
export const GROK_SEARCH_MODEL = "grok-4-1-fast-reasoning";
export const XAI_RESPONSES_API_URL = "https://api.x.ai/v1/responses";
export const DEFAULT_SECRET_ENV_PATH = join(homedir(), ".pi", "agent", "secrets", "kfrance-pi-pack.env");
export const SECRET_FILE_ENV_VAR = "KFRANCE_PI_PACK_SECRETS_FILE";
const MAX_WEB_DOMAINS = 5;
const MAX_X_HANDLES = 10;
const MAX_SEED_URLS = 5;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_CITATIONS = 12;
const MAX_TOOL_ACTIONS = 20;
const GROK_SEARCH_MODES = ["auto", "web", "x", "web+x"] as const;

export const GrokSearchParametersSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "What to research on the web/X. Ask for current external info, docs, release notes, or recent discussion.",
	}),
	mode: Type.Optional(
		StringEnum(GROK_SEARCH_MODES, {
			description: "Search mode. Use auto by default; prefer x or web+x for recent discussion-heavy topics.",
		})
	),
	fromDate: Type.Optional(
		Type.String({ description: "Optional ISO8601 lower bound, mainly for X/recent searches." })
	),
	toDate: Type.Optional(
		Type.String({ description: "Optional ISO8601 upper bound, mainly for X/recent searches." })
	),
	allowedDomains: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_WEB_DOMAINS,
			description: "Optional authoritative web domains to constrain the search (max 5).",
		})
	),
	allowedXHandles: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_X_HANDLES,
			description: "Optional X handles to constrain the search (max 10).",
		})
	),
	seedUrls: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_SEED_URLS,
			description: "Optional seed URLs to open or ground on early (max 5).",
		})
	),
	notes: Type.Optional(
		Type.String({
			description: "Optional research notes, constraints, or context that should shape the search.",
		})
	),
});

export type GrokSearchParams = Static<typeof GrokSearchParametersSchema>;
export type GrokSearchMode = typeof GROK_SEARCH_MODES[number];

export interface NormalizedGrokSearchParams {
	query: string;
	mode: GrokSearchMode;
	fromDate?: string;
	toDate?: string;
	allowedDomains: string[];
	allowedXHandles: string[];
	seedUrls: string[];
	notes?: string;
}

export interface GrokSearchCitation {
	url: string;
	title?: string;
	type?: string;
	startIndex?: number;
	endIndex?: number;
}

export interface GrokSearchToolAction {
	type: string;
	name?: string;
	action?: string;
	status?: string;
	query?: string;
	url?: string;
}

export interface GrokSearchToolDetails {
	model: string;
	responseId?: string;
	requestedMode: GrokSearchMode;
	enabledToolTypes: string[];
	filters: {
		fromDate?: string;
		toDate?: string;
		allowedDomains: string[];
		allowedXHandles: string[];
		seedUrls: string[];
	};
	citations: GrokSearchCitation[];
	citationCount: number;
	toolActions: GrokSearchToolAction[];
	toolActionCount: number;
	usage?: unknown;
}

export interface CreateGrokSearchToolOptions {
	apiKey?: string;
	apiUrl?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	secretFilePath?: string;
	readTextFile?: (path: string) => string;
	fileExists?: (path: string) => boolean;
}

interface ParsedGrokSearchResponse {
	summary: string;
	details: GrokSearchToolDetails;
}

interface XaiToolConfig {
	type: "web_search" | "x_search";
	allowed_domains?: string[];
	allowed_x_handles?: string[];
	from_date?: string;
	to_date?: string;
}

export function getSecretsFilePath(env: NodeJS.ProcessEnv = process.env): string {
	const overridden = env[SECRET_FILE_ENV_VAR]?.trim();
	return overridden || DEFAULT_SECRET_ENV_PATH;
}

export function parseEnvFile(content: string): Record<string, string> {
	const values: Record<string, string> = {};

	for (const rawLine of content.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
		const equalsIndex = normalizedLine.indexOf("=");
		if (equalsIndex <= 0) continue;

		const key = normalizedLine.slice(0, equalsIndex).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;

		let value = normalizedLine.slice(equalsIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"'))
			|| (value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		values[key] = value;
	}

	return values;
}

export function resolveXaiApiKey(options: {
	env?: NodeJS.ProcessEnv;
	secretFilePath?: string;
	readTextFile?: (path: string) => string;
	fileExists?: (path: string) => boolean;
} = {}): string | undefined {
	const env = options.env ?? process.env;
	const fromEnv = env.XAI_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	const secretFilePath = options.secretFilePath ?? getSecretsFilePath(env);
	const fileExists = options.fileExists ?? existsSync;
	if (!fileExists(secretFilePath)) return undefined;

	const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf-8"));
	const parsed = parseEnvFile(readTextFile(secretFilePath));
	const fromFile = parsed.XAI_API_KEY?.trim();
	return fromFile || undefined;
}

export function createGrokSearchTool(options: CreateGrokSearchToolOptions = {}): ToolDefinition<typeof GrokSearchParametersSchema, GrokSearchToolDetails> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const apiUrl = options.apiUrl ?? XAI_RESPONSES_API_URL;

	return {
		name: TOOL_NAME,
		label: "Grok Search",
		description:
			"Search the web and/or X for current external knowledge, docs, release notes, recent discussion, and other information outside the local workspace.",
		promptSnippet:
			"grok_search(query, mode?, allowedDomains?, allowedXHandles?, fromDate?, toDate?, seedUrls?, notes?) - Search web/X for external or recent information and return a concise sourced summary.",
		promptGuidelines: [
			"Prefer local tools for local codebase/workspace questions.",
			"Use grok_search when web/X/current external knowledge is needed.",
			"Prefer official or primary sources when available.",
			"Lean on X when the topic is recent, fast-moving, or discussion-driven.",
		],
		parameters: GrokSearchParametersSchema,
		async execute(_toolCallId, rawParams, signal) {
			const apiKey = options.apiKey?.trim() || resolveXaiApiKey(options);
			if (!apiKey) {
				throw new Error(
					`grok_search is not configured: XAI_API_KEY is missing. Set it in ${getSecretsFilePath(options.env ?? process.env)} or in the environment.`
				);
			}
			if (signal?.aborted) {
				throw new Error("grok_search aborted before the request started.");
			}

			const params = normalizeGrokSearchParams(rawParams);
			const requestBody = buildGrokSearchRequest(params);

			let response: Response;
			try {
				response = await fetchImpl(apiUrl, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(requestBody),
					signal,
				});
			} catch (error: any) {
				if (error?.name === "AbortError" || signal?.aborted) {
					throw new Error("grok_search request was aborted.");
				}
				throw new Error(`grok_search request failed: ${error?.message || "Unknown fetch error"}`);
			}

			if (!response.ok) {
				const errorBody = await readErrorBody(response);
				throw new Error(
					`grok_search request failed (${response.status} ${response.statusText}): ${errorBody}`
				);
			}

			let json: any;
			try {
				json = await response.json();
			} catch (error: any) {
				throw new Error(`grok_search returned invalid JSON: ${error?.message || "Unknown parse error"}`);
			}

			const parsed = parseGrokSearchResponse(json, params, requestBody.tools.map((tool) => tool.type));
			return {
				content: [{ type: "text", text: parsed.summary }],
				details: parsed.details,
			};
		},
	};
}

export function normalizeGrokSearchParams(rawParams: GrokSearchParams): NormalizedGrokSearchParams {
	const query = rawParams.query?.trim();
	if (!query) {
		throw new Error("grok_search requires a non-empty query.");
	}

	const mode = (rawParams.mode ?? "auto") as GrokSearchMode;
	const fromDate = normalizeIsoDate(rawParams.fromDate, "fromDate");
	const toDate = normalizeIsoDate(rawParams.toDate, "toDate");

	if (fromDate && toDate && new Date(fromDate).getTime() > new Date(toDate).getTime()) {
		throw new Error("grok_search requires fromDate to be before or equal to toDate.");
	}

	const allowedDomains = normalizeStringList(rawParams.allowedDomains, {
		label: "allowedDomains",
		maxItems: MAX_WEB_DOMAINS,
		normalize: normalizeDomain,
	});
	const allowedXHandles = normalizeStringList(rawParams.allowedXHandles, {
		label: "allowedXHandles",
		maxItems: MAX_X_HANDLES,
		normalize: normalizeXHandle,
	});
	const seedUrls = normalizeStringList(rawParams.seedUrls, {
		label: "seedUrls",
		maxItems: MAX_SEED_URLS,
		normalize: normalizeUrl,
	});
	const notes = rawParams.notes?.trim() || undefined;

	return {
		query,
		mode,
		fromDate,
		toDate,
		allowedDomains,
		allowedXHandles,
		seedUrls,
		notes,
	};
}

export function buildGrokSearchRequest(params: NormalizedGrokSearchParams): {
	model: string;
	input: Array<{ role: "system" | "user"; content: string }>;
	tools: XaiToolConfig[];
} {
	const tools = buildToolConfigs(params);
	return {
		model: GROK_SEARCH_MODEL,
		input: [
			{ role: "system", content: buildInternalInstruction(params) },
			{ role: "user", content: buildUserPrompt(params) },
		],
		tools,
	};
}

export function parseGrokSearchResponse(
	response: any,
	params: NormalizedGrokSearchParams,
	enabledToolTypes: string[]
): ParsedGrokSearchResponse {
	const messageTexts: string[] = [];
	const citations: GrokSearchCitation[] = [];
	const toolActions: GrokSearchToolAction[] = [];

	if (typeof response?.output_text === "string" && response.output_text.trim()) {
		messageTexts.push(response.output_text.trim());
	}

	for (const item of asArray(response?.output)) {
		if (item?.type === "message") {
			for (const content of asArray(item.content)) {
				if (content?.type === "output_text" && typeof content.text === "string" && content.text.trim()) {
					messageTexts.push(content.text.trim());
				}
				for (const annotation of asArray(content?.annotations)) {
					const citation = toCitation(annotation);
					if (citation) citations.push(citation);
				}
			}
			continue;
		}

		if (typeof item?.type === "string") {
			const action: GrokSearchToolAction = {
				type: item.type,
				name: typeof item.name === "string" ? item.name : undefined,
				action: typeof item.action === "string" ? item.action : undefined,
				status: typeof item.status === "string" ? item.status : undefined,
				query: firstString(item.query, item.search_query, item.arguments?.query),
				url: firstString(item.url, item.arguments?.url),
			};
			toolActions.push(action);
		}
	}

	for (const citation of asArray(response?.citations)) {
		const normalized = toCitation(citation);
		if (normalized) citations.push(normalized);
	}

	const dedupedCitations = dedupeByKey(citations, (citation) => citation.url);
	const dedupedToolActions = dedupeByKey(
		toolActions,
		(action) => `${action.type}:${action.name || ""}:${action.action || ""}:${action.query || ""}:${action.url || ""}`
	);

	const combinedMessageText = dedupeByKey(messageTexts, (text) => text).join("\n\n");
	const summary = truncateText(
		combinedMessageText
			|| (dedupedCitations.length > 0
				? "Search completed, but xAI did not return a natural-language summary. See the citations in tool details."
				: "Search completed, but xAI returned no usable summary text."),
		MAX_SUMMARY_CHARS
	);

	return {
		summary,
		details: {
			model: typeof response?.model === "string" ? response.model : GROK_SEARCH_MODEL,
			responseId: typeof response?.id === "string" ? response.id : undefined,
			requestedMode: params.mode,
			enabledToolTypes,
			filters: {
				fromDate: params.fromDate,
				toDate: params.toDate,
				allowedDomains: params.allowedDomains,
				allowedXHandles: params.allowedXHandles,
				seedUrls: params.seedUrls,
			},
			citations: dedupedCitations.slice(0, MAX_CITATIONS),
			citationCount: dedupedCitations.length,
			toolActions: dedupedToolActions.slice(0, MAX_TOOL_ACTIONS),
			toolActionCount: dedupedToolActions.length,
			usage: response?.usage,
		},
	};
}

function buildToolConfigs(params: NormalizedGrokSearchParams): XaiToolConfig[] {
	const tools: XaiToolConfig[] = [];

	if (params.mode === "auto" || params.mode === "web" || params.mode === "web+x") {
		const webTool: XaiToolConfig = { type: "web_search" };
		if (params.allowedDomains.length > 0) {
			webTool.allowed_domains = params.allowedDomains;
		}
		tools.push(webTool);
	}

	if (params.mode === "auto" || params.mode === "x" || params.mode === "web+x") {
		const xTool: XaiToolConfig = { type: "x_search" };
		if (params.allowedXHandles.length > 0) {
			xTool.allowed_x_handles = params.allowedXHandles;
		}
		if (params.fromDate) {
			xTool.from_date = params.fromDate;
		}
		if (params.toDate) {
			xTool.to_date = params.toDate;
		}
		tools.push(xTool);
	}

	return tools;
}

function buildInternalInstruction(params: NormalizedGrokSearchParams): string {
	const hints: string[] = [];
	if (params.allowedDomains.length > 0) {
		hints.push(`Authoritative web domains to prioritize: ${params.allowedDomains.join(", ")}.`);
	}
	if (params.allowedXHandles.length > 0) {
		hints.push(`Prefer or constrain to these X handles when searching X: ${params.allowedXHandles.join(", ")}.`);
	}
	if (params.seedUrls.length > 0) {
		hints.push(`Seed URLs to open or ground on early: ${params.seedUrls.join(", ")}.`);
	}
	if (params.fromDate || params.toDate) {
		hints.push(`Respect this date window when the X tool supports it: ${params.fromDate || "(no lower bound)"} → ${params.toDate || "(no upper bound)"}.`);
	}

	return [
		"You are a focused research sub-agent for pi's grok_search tool.",
		"The caller has already decided that external or current knowledge is needed.",
		"Prefer official or primary sources for docs, release notes, product behavior, and vendor announcements.",
		"Use web and X together when appropriate; lean on X when the topic is recent, fast-moving, or discussion-driven.",
		"For recent developments, separate the newest facts from older background and organize the answer chronologically when helpful.",
		"When the first pass is weak, search again with narrower entities, dates, domains, or URLs discovered in the first pass.",
		"When sources disagree, say so explicitly and distinguish official sources, reporting, commentary, and X discussion.",
		"Keep the final synthesis concise, grounded, and explicit about uncertainty.",
		...hints,
	].join("\n");
}

function buildUserPrompt(params: NormalizedGrokSearchParams): string {
	const sections = [
		`Research task: ${params.query}`,
		`Requested mode: ${params.mode}`,
	];

	if (params.allowedDomains.length > 0) {
		sections.push(`Allowed domains: ${params.allowedDomains.join(", ")}`);
	}
	if (params.allowedXHandles.length > 0) {
		sections.push(`Allowed X handles: ${params.allowedXHandles.join(", ")}`);
	}
	if (params.fromDate || params.toDate) {
		sections.push(`Date bounds: ${params.fromDate || "none"} → ${params.toDate || "none"}`);
	}
	if (params.seedUrls.length > 0) {
		sections.push(`Seed URLs: ${params.seedUrls.join(", ")}`);
	}
	if (params.notes) {
		sections.push(`Additional notes: ${params.notes}`);
	}

	sections.push(
		"Return a concise synthesis with the most important findings first. Prefer authoritative evidence, mention uncertainty when needed, and avoid padding."
	);

	return sections.join("\n");
}

function normalizeIsoDate(value: string | undefined, label: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
	if (dateOnlyMatch) {
		const [, year, month, day] = dateOnlyMatch;
		if (!isValidIsoCalendarDate({
			year: Number(year),
			month: Number(month),
			day: Number(day),
			hour: 0,
			minute: 0,
			second: 0,
			millisecond: 0,
			offsetMinutes: 0,
		})) {
			throw new Error(`grok_search received an invalid ${label}. Expected an ISO8601 date string.`);
		}
		return trimmed;
	}

	const dateTimeMatch = trimmed.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u
	);
	if (!dateTimeMatch) {
		throw new Error(`grok_search received an invalid ${label}. Expected an ISO8601 date string.`);
	}

	const [
		,
		year,
		month,
		day,
		hour,
		minute,
		second,
		fraction,
		timezone,
		offsetSign,
		offsetHours,
		offsetMinutes,
	] = dateTimeMatch;

	const millis = fraction ? Number(fraction.padEnd(3, "0")) : 0;
	const tzOffsetMinutes = timezone === "Z"
		? 0
		: (Number(offsetHours) * 60 + Number(offsetMinutes)) * (offsetSign === "+" ? 1 : -1);

	if (!isValidIsoCalendarDate({
		year: Number(year),
		month: Number(month),
		day: Number(day),
		hour: Number(hour),
		minute: Number(minute),
		second: second ? Number(second) : 0,
		millisecond: millis,
		offsetMinutes: tzOffsetMinutes,
	})) {
		throw new Error(`grok_search received an invalid ${label}. Expected an ISO8601 date string.`);
	}

	return trimmed;
}

function isValidIsoCalendarDate(parts: {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	millisecond: number;
	offsetMinutes: number;
}): boolean {
	const {
		year,
		month,
		day,
		hour,
		minute,
		second,
		millisecond,
		offsetMinutes,
	} = parts;

	if (
		!Number.isInteger(year)
		|| !Number.isInteger(month)
		|| !Number.isInteger(day)
		|| !Number.isInteger(hour)
		|| !Number.isInteger(minute)
		|| !Number.isInteger(second)
		|| !Number.isInteger(millisecond)
		|| !Number.isInteger(offsetMinutes)
	) {
		return false;
	}

	if (
		month < 1 || month > 12
		|| day < 1 || day > 31
		|| hour < 0 || hour > 23
		|| minute < 0 || minute > 59
		|| second < 0 || second > 59
		|| millisecond < 0 || millisecond > 999
	) {
		return false;
	}

	const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
		- offsetMinutes * 60_000;
	const shifted = new Date(utcMillis + offsetMinutes * 60_000);

	return (
		shifted.getUTCFullYear() === year
		&& shifted.getUTCMonth() + 1 === month
		&& shifted.getUTCDate() === day
		&& shifted.getUTCHours() === hour
		&& shifted.getUTCMinutes() === minute
		&& shifted.getUTCSeconds() === second
		&& shifted.getUTCMilliseconds() === millisecond
	);
}

function normalizeStringList(
	input: string[] | undefined,
	options: { label: string; maxItems: number; normalize: (value: string) => string }
): string[] {
	const values = (input ?? [])
		.map((item) => options.normalize(item))
		.filter(Boolean);

	const deduped = Array.from(new Set(values));
	if (deduped.length > options.maxItems) {
		throw new Error(`grok_search supports at most ${options.maxItems} values for ${options.label}.`);
	}
	return deduped;
}

function normalizeDomain(value: string): string {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return "";

	let host: string;
	try {
		const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
		host = new URL(candidate).hostname;
	} catch {
		const withoutProtocol = trimmed.replace(/^https?:\/\//u, "");
		host = withoutProtocol.split(/[/?#:]/u, 1)[0] ?? "";
	}

	const normalized = host.replace(/^www\./u, "");
	if (!normalized || normalized.includes(" ")) {
		throw new Error(`grok_search received an invalid domain: ${value}`);
	}
	return normalized;
}

function normalizeXHandle(value: string): string {
	const trimmed = value.trim().replace(/^@+/u, "").toLowerCase();
	if (!trimmed) return "";
	if (!/^[a-z0-9_]{1,15}$/iu.test(trimmed)) {
		throw new Error(`grok_search received an invalid X handle: ${value}`);
	}
	return trimmed;
}

function normalizeUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`grok_search received an invalid URL: ${value}`);
	}
	return url.toString();
}

async function readErrorBody(response: Response): Promise<string> {
	try {
		const text = await response.text();
		const normalized = text.trim();
		return truncateText(normalized || "(empty response body)", 1_000);
	} catch {
		return "(unable to read error body)";
	}
}

function toCitation(value: any): GrokSearchCitation | undefined {
	if (typeof value === "string") {
		return { url: value };
	}
	if (!value || typeof value !== "object" || typeof value.url !== "string") {
		return undefined;
	}
	return {
		url: value.url,
		title: typeof value.title === "string" ? value.title : undefined,
		type: typeof value.type === "string" ? value.type : undefined,
		startIndex: typeof value.start_index === "number" ? value.start_index : undefined,
		endIndex: typeof value.end_index === "number" ? value.end_index : undefined,
	};
}

function asArray(value: any): any[] {
	return Array.isArray(value) ? value : [];
}

function firstString(...values: any[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return undefined;
}

function dedupeByKey<T>(values: T[], getKey: (value: T) => string): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const value of values) {
		const key = getKey(value);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(value);
	}
	return result;
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export default function grokSearchExtension(pi: ExtensionAPI) {
	pi.registerTool(createGrokSearchTool());
}
