/**
 * Anthropic sign-in through the official `ant` CLI
 *
 * Lets pi's built-in `anthropic` provider use the OAuth sign-in from
 * `ant auth login` instead of an API key.
 *
 * Design:
 * - Registers a native provider with id "anthropic": pi's built-in Anthropic
 *   provider with its API-key auth wrapped. A provider registered this way
 *   replaces the built-in one as the composition base, and models.json
 *   overrides still apply on top of it.
 * - `check()` reports Anthropic as configured, so its models are listed in
 *   `/model` and in an SDK ModelRuntime without a stored key. It runs nothing.
 * - `resolve()` keeps the built-in order first: a stored API key in auth.json,
 *   then ANTHROPIC_AUTH_TOKEN / ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_API_KEY and
 *   workload identity federation. Only when none of those exist does it mark
 *   the request for ant. The provider's stream then asks
 *   `ant auth print-credentials` for a token and sends it as
 *   `Authorization: Bearer <token>`. A stored OAuth login (`/login` with a
 *   Claude subscription) never reaches this code.
 * - The token is kept in memory only, until 60 seconds before it expires
 *   (5 minutes when the expiry is unknown), and a 401 drops it. It is never
 *   written to disk or logged, and it is redacted from error messages.
 * - Requests that carry the ant token go through a fetch wrapper on this
 *   provider only. It adds `anthropic-beta: oauth-2025-04-20` to the betas pi
 *   computed and removes any `x-api-key`. (`before_provider_headers` cannot do
 *   this: it is not told the provider, and it runs before the Anthropic client
 *   builds its `anthropic-beta` header from the request's betas.)
 * - If `ant` is missing or not signed in, the request fails with
 *   "Claude needs the ant sign-in. Run: ant auth login".
 *
 * `ant` is looked up as PI_ANT_BIN, then on PATH, then ~/.local/bin/ant.
 * ANTHROPIC_PROFILE selects an `ant` profile.
 */

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { type ApiKeyAuth, type AuthResult, lazyStream, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ANT_SIGN_IN_MESSAGE = "Claude needs the ant sign-in. Run: ant auth login";
export const OAUTH_BETA = "oauth-2025-04-20";
export const ANT_AUTH_SOURCE = "ant sign-in";
/** Marks resolved auth that came from `ant`; stripped before the request is sent. */
export const ANT_MARKER_HEADER = "x-pi-ant-auth";

const EXPIRY_MARGIN_MS = 60_000;
const UNKNOWN_EXPIRY_TTL_MS = 5 * 60_000;
const ANT_TIMEOUT_MS = 20_000;

export interface AntTokenSourceOptions {
	/** Path to the `ant` binary. Default: PI_ANT_BIN, PATH, ~/.local/bin/ant. */
	antPath?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	timeoutMs?: number;
}

export class AntSignInError extends Error {
	constructor(detail?: string) {
		super(detail ? `${ANT_SIGN_IN_MESSAGE} (${detail})` : ANT_SIGN_IN_MESSAGE);
		this.name = "AntSignInError";
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function findAnt(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.PI_ANT_BIN;
	if (override) return isExecutable(override) ? override : undefined;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir || !isAbsolute(dir)) continue;
		const candidate = join(dir, "ant");
		if (isExecutable(candidate)) return candidate;
	}
	const local = join(env.HOME || homedir(), ".local", "bin", "ant");
	return isExecutable(local) ? local : undefined;
}

/** Parse an expiry given as RFC 3339 text, epoch seconds, or epoch milliseconds. */
export function parseExpiry(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
		const numeric = Number(value);
		return Number.isFinite(numeric) ? parseExpiry(numeric) : undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	if (value > 1e12) return value; // epoch milliseconds
	if (value > 1e9) return value * 1000; // epoch seconds
	return undefined;
}

interface ParsedCredentials {
	token: string;
	expiresAt?: number;
}

/** Read `ant auth print-credentials` JSON output. Never echoes the input. */
export function parseCredentialsJson(stdout: string, now: number): ParsedCredentials | undefined {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	const nested = [record, record.credentials, record.oauth, record.token].filter(
		(entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
	);
	for (const entry of nested) {
		const token = entry.access_token ?? entry.accessToken;
		if (typeof token !== "string" || !isPlausibleToken(token)) continue;
		let expiresAt: number | undefined;
		for (const key of ["expires_at", "expiresAt", "expires", "expiry"]) {
			expiresAt ??= parseExpiry(entry[key]);
		}
		const expiresIn = entry.expires_in ?? entry.expiresIn;
		if (expiresAt === undefined && typeof expiresIn === "number" && expiresIn > 0) {
			expiresAt = now + expiresIn * 1000;
		}
		return { token, expiresAt };
	}
	return undefined;
}

function isPlausibleToken(token: string): boolean {
	return token.length >= 4 && !/\s/.test(token) && !/^[{["]/.test(token);
}

/** Remove anything token-like from text before it can reach an error message. */
export function redactSecrets(text: string, secrets: Iterable<string> = []): string {
	let out = text;
	for (const secret of secrets) {
		if (secret) out = out.split(secret).join("[redacted]");
	}
	return out
		.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[redacted]")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]")
		.replace(/"(access_token|refresh_token|accessToken|refreshToken)"\s*:\s*"[^"]*"/g, '"$1":"[redacted]"');
}

interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	missing: boolean;
	timedOut: boolean;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
			const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
			resolvePromise({
				stdout: stdout ?? "",
				stderr: stderr ?? "",
				code: err ? (typeof err.code === "number" ? err.code : null) : 0,
				missing: err?.code === "ENOENT" || err?.code === "EACCES",
				timedOut: !!err?.killed,
			});
		});
	});
}

/** Fetches the ant access token and caches it in memory. */
export class AntTokenSource {
	private cached: { token: string; validUntil: number } | undefined;
	private inflight: Promise<string> | undefined;
	private readonly seen = new Set<string>();
	private readonly now: () => number;
	/** Set once ant's JSON output turns out to have no token we can read. */
	private bareOnly = false;

	constructor(private readonly options: AntTokenSourceOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	redact(text: string): string {
		return redactSecrets(text, this.seen);
	}

	async getToken(): Promise<string> {
		if (this.cached && this.now() < this.cached.validUntil) return this.cached.token;
		this.inflight ??= this.fetchToken().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private remember(token: string, expiresAt: number | undefined): string {
		const now = this.now();
		const validUntil = expiresAt !== undefined ? expiresAt - EXPIRY_MARGIN_MS : now + UNKNOWN_EXPIRY_TTL_MS;
		// Remember recent tokens so they can be redacted from error text.
		if (this.seen.size > 8) this.seen.clear();
		this.seen.add(token);
		this.cached = validUntil > now ? { token, validUntil } : undefined;
		return token;
	}

	private async fetchToken(): Promise<string> {
		const env = this.options.env ?? process.env;
		const ant = this.options.antPath ?? findAnt(env);
		if (!ant) throw new AntSignInError();
		const timeoutMs = this.options.timeoutMs ?? ANT_TIMEOUT_MS;

		if (!this.bareOnly) {
			const json = await run(ant, ["auth", "print-credentials"], env, timeoutMs);
			this.check(json);
			const parsed = parseCredentialsJson(json.stdout, this.now());
			if (parsed) return this.remember(parsed.token, parsed.expiresAt);
			this.bareOnly = true;
		}

		// Unknown JSON shape: ask for the bare token instead.
		const bare = await run(ant, ["auth", "print-credentials", "--access-token"], env, timeoutMs);
		this.check(bare);
		const token = bare.stdout.trim().split("\n")[0]?.trim() ?? "";
		if (!isPlausibleToken(token)) throw new AntSignInError("ant printed no access token");
		return this.remember(token, undefined);
	}

	private check(result: RunResult): void {
		if (result.missing) throw new AntSignInError();
		if (result.timedOut) throw new AntSignInError("ant auth print-credentials timed out");
		if (result.code !== 0) {
			const reason = this.redact(result.stderr).trim().split("\n")[0]?.slice(0, 200);
			throw new AntSignInError(reason || undefined);
		}
	}
}

function hasHeader(headers: Record<string, string | null> | undefined, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === lower);
}

/** fetch for requests that carry the ant token: add the OAuth beta, drop x-api-key. */
export function createAntFetch(source: AntTokenSource, baseFetch?: typeof fetch): typeof fetch {
	return async (input, init) => {
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.delete("x-api-key");
		const betas = (headers.get("anthropic-beta") ?? "")
			.split(",")
			.map((beta) => beta.trim())
			.filter(Boolean);
		if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
		headers.set("anthropic-beta", betas.join(","));
		const response = await (baseFetch ?? globalThis.fetch)(input, { ...init, headers });
		if (response.status === 401) source.invalidate();
		return response;
	};
}

type RequestOptions = { headers?: Record<string, string | null>; fetch?: typeof fetch; signal?: AbortSignal } | undefined;

/** Swap the marker for the bearer token and route the request through createAntFetch. */
function antRequestOptions<T>(options: T, token: string, source: AntTokenSource): T {
	const opts = (options ?? {}) as NonNullable<RequestOptions>;
	const headers: Record<string, string | null> = {};
	for (const [key, value] of Object.entries(opts.headers ?? {})) {
		const lower = key.toLowerCase();
		if (lower === ANT_MARKER_HEADER || lower === "x-api-key" || lower === "authorization") continue;
		headers[key] = value;
	}
	headers.Authorization = `Bearer ${token}`;
	return { ...opts, headers, fetch: createAntFetch(source, opts.fetch) } as T;
}

/** Pi's Anthropic provider with ant as the last-resort auth source. */
export function createAntAuthProvider(base: Provider, source: AntTokenSource): Provider {
	const inherited = base.auth.apiKey;
	if (!inherited) throw new Error(`Provider ${base.id} has no API-key auth to extend`);

	const apiKey: ApiKeyAuth = {
		name: inherited.name,
		login: inherited.login,
		async check(input) {
			// The built-in resolve only reads the stored credential and env vars.
			const existing = inherited.check ? await inherited.check(input) : await inherited.resolve(input);
			return { type: "api_key", source: existing?.source ?? ANT_AUTH_SOURCE };
		},
		async resolve(input): Promise<AuthResult | undefined> {
			const existing = await inherited.resolve(input);
			if (existing) return existing;
			// The token is fetched when the request is sent (see wrap below), so
			// resolving auth never runs ant and a missing sign-in fails the request
			// with ANT_SIGN_IN_MESSAGE.
			return { auth: { headers: { [ANT_MARKER_HEADER]: "1" } }, source: ANT_AUTH_SOURCE };
		},
	};

	type StreamFn = NonNullable<Provider["stream"]>;
	const wrap = <F extends StreamFn | Provider["streamSimple"]>(fn: F): F =>
		((model: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2]) => {
			if (!hasHeader((options as RequestOptions)?.headers, ANT_MARKER_HEADER)) return fn!(model, context, options as never);
			return lazyStream(
				model,
				async () => fn!(model, context, antRequestOptions(options, await source.getToken(), source) as never),
				undefined,
				(options as RequestOptions)?.signal,
			);
		}) as F;

	return {
		...base,
		auth: { ...base.auth, apiKey },
		stream: wrap(base.stream),
		streamSimple: wrap(base.streamSimple),
	};
}

export function createAntAuthExtension(options: AntTokenSourceOptions = {}) {
	return function antAuthExtension(pi: ExtensionAPI) {
		const base = builtinProviders().find((provider) => provider.id === "anthropic");
		if (!base) return;
		pi.registerProvider(createAntAuthProvider(base, new AntTokenSource(options)));
	};
}

export default createAntAuthExtension();
