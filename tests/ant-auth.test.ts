import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	ANT_AUTH_SOURCE,
	ANT_SIGN_IN_MESSAGE,
	AntTokenSource,
	createAntAuthExtension,
	createAntAuthProvider,
	createAntFetch,
	OAUTH_BETA,
	parseExpiry,
	redactSecrets,
} from "../extensions/ant-auth.ts";

// A stand-in for `ant auth print-credentials [--access-token]`. Its behavior
// is read from files in $FAKE_ANT_STATE so each test can change it.
const FAKE_ANT = `#!/bin/bash
state="$FAKE_ANT_STATE"
n=$(( $(cat "$state/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$state/count"
mode=$(cat "$state/mode" 2>/dev/null || echo json)
[ "$1 $2" = "auth print-credentials" ] || { echo "unexpected args: $*" >&2; exit 2; }
case "$mode" in
  json)
    echo "{\\"access_token\\":\\"tok-$n\\",\\"refresh_token\\":\\"refresh-secret\\",\\"expires_at\\":\\"$(cat "$state/expires")\\"}" ;;
  bare)
    if [ "$3" = "--access-token" ]; then echo "tok-$n"; else echo '{"profile":"default"}'; fi ;;
  fail)
    echo "not logged in; last token was $(cat "$state/leak" 2>/dev/null) and sk-ant-oat01-SECRETVALUE" >&2
    exit 1 ;;
esac
`;

let root: string;
let binDir: string;
let state: string;

function setState(mode: "json" | "bare" | "fail", expiresAt?: number, leak?: string) {
	writeFileSync(join(state, "mode"), mode);
	writeFileSync(join(state, "expires"), expiresAt ? new Date(expiresAt).toISOString() : "");
	writeFileSync(join(state, "count"), "0");
	if (leak) writeFileSync(join(state, "leak"), leak);
}

function antCalls(): number {
	return Number(readFileSync(join(state, "count"), "utf8").trim() || "0");
}

function antEnv(): NodeJS.ProcessEnv {
	return { ...process.env, FAKE_ANT_STATE: state, PATH: `${binDir}:${process.env.PATH}`, PI_ANT_BIN: "" };
}

function anthropicBase(): Provider {
	const base = builtinProviders().find((provider) => provider.id === "anthropic");
	assert.ok(base);
	return base;
}

const noEnv = { env: async () => undefined, fileExists: async () => false };

interface Captured {
	url: string;
	headers: Headers;
}

function recordingFetch(captured: Captured[], status = 400): typeof fetch {
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		captured.push({ url, headers: new Headers(init?.headers) });
		return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "test stop" } }), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
}

async function sendOnce(provider: Provider, options: { credentials?: InMemoryCredentialStore; headers?: Record<string, string> } = {}) {
	const models = createModels({ credentials: options.credentials ?? new InMemoryCredentialStore(), authContext: noEnv });
	models.setProvider(provider);
	const model = models.getModels("anthropic").find((entry) => entry.id === "claude-sonnet-5-5");
	assert.ok(model, "claude-sonnet-5-5 is in the built-in catalog");
	const captured: Captured[] = [];
	const result = await models
		.stream(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, {
			fetch: recordingFetch(captured),
			headers: options.headers,
			maxRetries: 0,
		} as never)
		.result();
	return { models, captured, result };
}

describe("ant-auth", () => {
	before(() => {
		root = mkdtempSync(join(tmpdir(), "pi-ant-auth-test-"));
		binDir = join(root, "bin");
		state = join(root, "state");
		mkdirSync(binDir);
		mkdirSync(state);
		writeFileSync(join(binDir, "ant"), FAKE_ANT);
		chmodSync(join(binDir, "ant"), 0o755);
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	it("lists Anthropic models as available without a stored key", async () => {
		setState("json", Date.now() + 3600_000);
		const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: noEnv });
		models.setProvider(createAntAuthProvider(anthropicBase(), new AntTokenSource({ env: antEnv() })));
		const available = await models.getAvailable("anthropic");
		assert.ok(available.some((model) => model.id === "claude-opus-5-5"));
		assert.deepStrictEqual(await models.checkAuth("anthropic"), { type: "api_key", source: ANT_AUTH_SOURCE });
		assert.strictEqual(antCalls(), 0, "checking availability does not run ant");
	});

	it("sends the ant token as a bearer with the OAuth beta and no x-api-key", async () => {
		setState("json", Date.now() + 3600_000);
		const provider = createAntAuthProvider(anthropicBase(), new AntTokenSource({ env: antEnv() }));
		const { captured } = await sendOnce(provider, { headers: { "x-api-key": "should-be-removed" } });
		assert.strictEqual(captured.length, 1);
		const headers = captured[0].headers;
		assert.match(captured[0].url, /^https:\/\/api\.anthropic\.com\//);
		assert.strictEqual(headers.get("authorization"), "Bearer tok-1");
		assert.strictEqual(headers.get("x-api-key"), null);
		assert.strictEqual(headers.get("x-pi-ant-auth"), null);
		const betas = (headers.get("anthropic-beta") ?? "").split(",");
		assert.ok(betas.includes(OAUTH_BETA), `betas: ${betas.join(",")}`);
		assert.ok(betas.length > 1, "keeps the betas pi computed");
		assert.strictEqual(antCalls(), 1);
	});

	it("leaves a stored Anthropic API key working and does not run ant", async () => {
		setState("json", Date.now() + 3600_000);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-stored-test-key" }));
		const provider = createAntAuthProvider(anthropicBase(), new AntTokenSource({ env: antEnv() }));
		const { captured } = await sendOnce(provider, { credentials });
		const headers = captured[0].headers;
		assert.strictEqual(headers.get("x-api-key"), "sk-stored-test-key");
		assert.strictEqual(headers.get("authorization"), null);
		assert.ok(!(headers.get("anthropic-beta") ?? "").includes(OAUTH_BETA));
		assert.strictEqual(antCalls(), 0);
	});

	it("registers only the anthropic provider and no request hooks", () => {
		const registered: Provider[] = [];
		const hooks: string[] = [];
		createAntAuthExtension({ env: antEnv() })({
			registerProvider: (provider: Provider) => registered.push(provider),
			on: (event: string) => hooks.push(event),
		} as never);
		assert.deepStrictEqual(
			registered.map((provider) => provider.id),
			["anthropic"],
		);
		assert.deepStrictEqual(hooks, []);
	});

	it("does not touch requests to other providers", async () => {
		setState("json", Date.now() + 3600_000);
		const other = builtinProviders().find((provider) => provider.id === "openai");
		assert.ok(other);
		const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: noEnv });
		models.setProvider(createAntAuthProvider(anthropicBase(), new AntTokenSource({ env: antEnv() })));
		models.setProvider(other);
		const openaiModel = models.getModels("openai")[0];
		const captured: Captured[] = [];
		await models
			.stream(openaiModel, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, {
				fetch: recordingFetch(captured),
				apiKey: "sk-openai-test",
				maxRetries: 0,
			} as never)
			.result();
		assert.ok(captured.length >= 1);
		assert.strictEqual(captured[0].headers.get("authorization"), "Bearer sk-openai-test");
		assert.ok(!(captured[0].headers.get("anthropic-beta") ?? "").includes(OAUTH_BETA));
		assert.strictEqual(antCalls(), 0);
	});

	it("caches the token until 60s before expiry, then refreshes", async () => {
		let now = 1_000_000;
		setState("json", now + 120_000);
		const source = new AntTokenSource({ env: antEnv(), now: () => now });
		assert.strictEqual(await source.getToken(), "tok-1");
		now += 30_000;
		assert.strictEqual(await source.getToken(), "tok-1");
		assert.strictEqual(antCalls(), 1);
		now += 31_000; // within 60s of expiry
		assert.strictEqual(await source.getToken(), "tok-2");
		assert.strictEqual(antCalls(), 2);
	});

	it("caches a token with unknown expiry for at most 5 minutes", async () => {
		let now = 5_000_000;
		setState("bare");
		const source = new AntTokenSource({ env: antEnv(), now: () => now });
		assert.strictEqual(await source.getToken(), "tok-2"); // JSON call, then --access-token
		now += 4 * 60_000;
		assert.strictEqual(await source.getToken(), "tok-2");
		now += 60_001;
		assert.strictEqual(await source.getToken(), "tok-3"); // later refreshes skip the JSON call
	});

	it("drops the cached token after a 401", async () => {
		setState("json", Date.now() + 3600_000);
		const source = new AntTokenSource({ env: antEnv() });
		assert.strictEqual(await source.getToken(), "tok-1");
		await createAntFetch(source, recordingFetch([], 401))("https://api.anthropic.com/v1/messages", { headers: {} });
		assert.strictEqual(await source.getToken(), "tok-2");
	});

	it("fails the request with the fix-it message when ant is missing", async () => {
		const env = { ...process.env, PATH: "/nonexistent", HOME: root, PI_ANT_BIN: "" };
		const provider = createAntAuthProvider(anthropicBase(), new AntTokenSource({ env }));
		const { result, captured } = await sendOnce(provider);
		assert.strictEqual(result.stopReason, "error");
		assert.strictEqual(result.errorMessage, ANT_SIGN_IN_MESSAGE);
		assert.strictEqual(captured.length, 0, "nothing is sent");
	});

	it("fails with the fix-it message when ant is not signed in, without leaking tokens", async () => {
		setState("json", Date.now() + 1_000);
		const source = new AntTokenSource({ env: antEnv() });
		const first = await source.getToken(); // expires within the margin, so it is not cached
		setState("fail", undefined, first);
		const provider = createAntAuthProvider(anthropicBase(), source);
		const { result } = await sendOnce(provider);
		assert.strictEqual(result.stopReason, "error");
		assert.ok(result.errorMessage?.startsWith(ANT_SIGN_IN_MESSAGE), result.errorMessage);
		assert.ok(!result.errorMessage?.includes(first), "previous token redacted");
		assert.ok(!result.errorMessage?.includes("SECRETVALUE"), "sk-ant token redacted");
		await assert.rejects(source.getToken(), (error: Error) => !error.message.includes(first) && error.message.startsWith(ANT_SIGN_IN_MESSAGE));
	});

	it("redacts token-like strings", () => {
		const text = redactSecrets('a sk-ant-oat01-abc_DEF b Bearer xyz.123 c {"access_token":"t0k"} d mine', ["mine"]);
		assert.ok(!/abc_DEF|xyz\.123|t0k|mine/.test(text), text);
	});

	it("parses expiry formats", () => {
		assert.strictEqual(parseExpiry("2030-01-01T00:00:00Z"), Date.parse("2030-01-01T00:00:00Z"));
		assert.strictEqual(parseExpiry(1_900_000_000), 1_900_000_000_000);
		assert.strictEqual(parseExpiry(1_900_000_000_000), 1_900_000_000_000);
		assert.strictEqual(parseExpiry(""), undefined);
		assert.strictEqual(parseExpiry(undefined), undefined);
	});
});
