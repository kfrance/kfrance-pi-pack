import { describe, it } from "node:test";
import assert from "node:assert";
import grokSearchExtension, {
	DEFAULT_SECRET_ENV_PATH,
	GROK_SEARCH_MODEL,
	SECRET_FILE_ENV_VAR,
	TOOL_NAME,
	buildGrokSearchRequest,
	createGrokSearchTool,
	getSecretsFilePath,
	normalizeGrokSearchParams,
	parseEnvFile,
	parseGrokSearchResponse,
	resolveXaiApiKey,
} from "../extensions/grok-search.ts";

describe("grok-search", () => {
	describe("parseEnvFile", () => {
		it("parses simple env assignments, export prefixes, and quoted values", () => {
			const parsed = parseEnvFile([
				"# comment",
				"XAI_API_KEY=plain-value",
				"export OTHER_KEY='two'",
				"QUOTED=\"three\"",
				"IGNORED LINE",
			].join("\n"));

			assert.deepStrictEqual(parsed, {
				XAI_API_KEY: "plain-value",
				OTHER_KEY: "two",
				QUOTED: "three",
			});
		});
	});

	describe("secret resolution", () => {
		it("uses the default secrets file path when no override is set", () => {
			assert.strictEqual(getSecretsFilePath({}), DEFAULT_SECRET_ENV_PATH);
		});

		it("uses the override secrets file path environment variable", () => {
			assert.strictEqual(
				getSecretsFilePath({ [SECRET_FILE_ENV_VAR]: "~/custom.env" }),
				"~/custom.env"
			);
		});

		it("prefers XAI_API_KEY from the environment over the secrets file", () => {
			const apiKey = resolveXaiApiKey({
				env: { XAI_API_KEY: " env-key " },
				secretFilePath: "/tmp/ignored.env",
				fileExists: () => true,
				readTextFile: () => "XAI_API_KEY=file-key",
			});

			assert.strictEqual(apiKey, "env-key");
		});

		it("falls back to the secrets file when the environment is missing", () => {
			const apiKey = resolveXaiApiKey({
				env: {},
				secretFilePath: "/tmp/kfrance-pi-pack.env",
				fileExists: () => true,
				readTextFile: () => "XAI_API_KEY=file-key\nOTHER_KEY=1",
			});

			assert.strictEqual(apiKey, "file-key");
		});
	});

	describe("normalizeGrokSearchParams", () => {
		it("trims input, dedupes filters, and defaults mode to auto", () => {
			const normalized = normalizeGrokSearchParams({
				query: "  latest Grok API changes  ",
				allowedDomains: ["https://Docs.X.AI/path", "docs.x.ai", "www.docs.x.ai"],
				allowedXHandles: ["@xAI", "xai", "XAI"],
				seedUrls: [" https://docs.x.ai/developers/tools/web-search ", "https://docs.x.ai/developers/tools/web-search"],
				notes: "  prefer official docs  ",
			});

			assert.deepStrictEqual(normalized, {
				query: "latest Grok API changes",
				mode: "auto",
				allowedDomains: ["docs.x.ai"],
				allowedXHandles: ["xai"],
				seedUrls: ["https://docs.x.ai/developers/tools/web-search"],
				notes: "prefer official docs",
				fromDate: undefined,
				toDate: undefined,
			});
		});

		it("normalizes allowed domains from pasted URLs with query strings and fragments", () => {
			const normalized = normalizeGrokSearchParams({
				query: "latest Grok API changes",
				allowedDomains: [
					"https://docs.x.ai?x=1#overview",
					"https://www.docs.x.ai#fragment",
				],
			});

			assert.deepStrictEqual(normalized.allowedDomains, ["docs.x.ai"]);
		});

		it("rejects non-ISO and impossible calendar dates", () => {
			assert.throws(
				() => normalizeGrokSearchParams({ query: "Recent updates", fromDate: "March 1, 2024" }),
				/invalid fromDate/i,
			);
			assert.throws(
				() => normalizeGrokSearchParams({ query: "Recent updates", toDate: "2024-02-31" }),
				/invalid toDate/i,
			);
		});
	});

	describe("buildGrokSearchRequest", () => {
		it("builds a web-only request with authoritative domain filtering", () => {
			const request = buildGrokSearchRequest(
				normalizeGrokSearchParams({
					query: "What does xAI say about web search?",
					mode: "web",
					allowedDomains: ["docs.x.ai"],
					seedUrls: ["https://docs.x.ai/developers/tools/web-search"],
				})
			);

			assert.strictEqual(request.model, GROK_SEARCH_MODEL);
			assert.deepStrictEqual(request.tools, [{ type: "web_search", allowed_domains: ["docs.x.ai"] }]);
			assert.strictEqual(request.input[0]?.role, "system");
			assert.match(request.input[0]?.content ?? "", /Prefer official or primary sources/);
			assert.match(request.input[0]?.content ?? "", /Seed URLs to open or ground on early/);
			assert.match(request.input[1]?.content ?? "", /Requested mode: web/);
			assert.match(request.input[1]?.content ?? "", /Allowed domains: docs.x.ai/);
		});

		it("builds an X-only request with handles and date filters", () => {
			const request = buildGrokSearchRequest(
				normalizeGrokSearchParams({
					query: "What has @xai posted recently about Grok?",
					mode: "x",
					allowedXHandles: ["@xai"],
					fromDate: "2026-01-01T00:00:00Z",
					toDate: "2026-02-01T00:00:00Z",
				})
			);

			assert.deepStrictEqual(request.tools, [
				{
					type: "x_search",
					allowed_x_handles: ["xai"],
					from_date: "2026-01-01T00:00:00Z",
					to_date: "2026-02-01T00:00:00Z",
				},
			]);
			assert.match(request.input[1]?.content ?? "", /Allowed X handles: xai/);
			assert.match(request.input[1]?.content ?? "", /Date bounds: 2026-01-01T00:00:00Z → 2026-02-01T00:00:00Z/);
		});

		it("uses both tools in auto mode so the model can choose the best mix", () => {
			const request = buildGrokSearchRequest(
				normalizeGrokSearchParams({
					query: "Summarize recent Grok API changes and discussion",
				})
			);

			assert.deepStrictEqual(request.tools.map((tool) => tool.type), ["web_search", "x_search"]);
		});
	});

	describe("parseGrokSearchResponse", () => {
		it("parses summary text, citations, and tool actions from a Responses API payload", () => {
			const parsed = parseGrokSearchResponse(
				{
					id: "resp_123",
					model: GROK_SEARCH_MODEL,
					usage: { input_tokens: 123, output_tokens: 45 },
					citations: [{ url: "https://x.com/xai/status/1", title: "2", type: "url_citation" }],
					output: [
						{ type: "web_search_call", action: "search", status: "completed", query: "latest grok api changes" },
						{ type: "custom_tool_call", name: "x_keyword_search", status: "completed", query: "@xai grok api" },
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "output_text",
									text: "xAI added Grok search support with web and X retrieval.",
									annotations: [
										{
											type: "url_citation",
											url: "https://docs.x.ai/developers/tools/web-search",
											title: "1",
											start_index: 0,
											end_index: 10,
										},
									],
								},
							],
						},
					],
				},
				normalizeGrokSearchParams({
					query: "Summarize recent Grok API changes and discussion",
					mode: "auto",
				}),
				["web_search", "x_search"]
			);

			assert.match(parsed.summary, /xAI added Grok search support/);
			assert.strictEqual(parsed.details.responseId, "resp_123");
			assert.strictEqual(parsed.details.model, GROK_SEARCH_MODEL);
			assert.strictEqual(parsed.details.citationCount, 2);
			assert.deepStrictEqual(
				parsed.details.citations.map((citation) => citation.url),
				[
					"https://docs.x.ai/developers/tools/web-search",
					"https://x.com/xai/status/1",
				]
			);
			assert.strictEqual(parsed.details.toolActionCount, 2);
			assert.ok(parsed.details.toolActions.some((action) => action.type === "web_search_call" && action.action === "search"));
			assert.ok(parsed.details.toolActions.some((action) => action.type === "custom_tool_call" && action.name === "x_keyword_search"));
		});

		it("includes every output_text block in the summary", () => {
			const parsed = parseGrokSearchResponse(
				{
					output: [
						{
							type: "message",
							role: "assistant",
							content: [
								{ type: "output_text", text: "First part.", annotations: [] },
								{ type: "output_text", text: "Second part.", annotations: [] },
							],
						},
					],
				},
				normalizeGrokSearchParams({ query: "Multi-part response" }),
				["web_search"]
			);

			assert.match(parsed.summary, /First part\./);
			assert.match(parsed.summary, /Second part\./);
		});

		it("truncates oversized summaries", () => {
			const longText = "A".repeat(4_500);
			const parsed = parseGrokSearchResponse(
				{
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: longText, annotations: [] }],
						},
					],
				},
				normalizeGrokSearchParams({ query: "Long summary test" }),
				["web_search", "x_search"]
			);

			assert.ok(parsed.summary.length <= 4_000);
			assert.ok(parsed.summary.endsWith("…"));
		});
	});

	describe("createGrokSearchTool", () => {
		it("fails clearly when XAI_API_KEY is missing", async () => {
			let called = false;
			const fetchImpl = async () => {
				called = true;
				throw new Error("should not be called");
			};
			const tool = createGrokSearchTool({
				fetchImpl: fetchImpl as typeof fetch,
				env: {},
				secretFilePath: "/tmp/does-not-exist.env",
				fileExists: () => false,
			});

			await assert.rejects(
				() => tool.execute("call-1", { query: "What is xAI?" }, undefined, undefined, {} as any),
				/XAI_API_KEY is missing/
			);
			assert.strictEqual(called, false);
		});

		it("uses the secrets file when no env key is present", async () => {
			let receivedAuthHeader = "";
			let receivedBody = "";
			const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
				receivedAuthHeader = String(init?.headers ? (init.headers as Record<string, string>).Authorization : "");
				receivedBody = String(init?.body ?? "");
				return new Response(JSON.stringify({ output_text: "Done" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};
			const tool = createGrokSearchTool({
				fetchImpl: fetchImpl as typeof fetch,
				env: {},
				secretFilePath: "/tmp/kfrance-pi-pack.env",
				fileExists: () => true,
				readTextFile: () => "XAI_API_KEY=file-key",
			});

			const result = await tool.execute("call-secret", { query: "What is xAI?", mode: "web" }, undefined, undefined, {} as any);
			assert.strictEqual(receivedAuthHeader, "Bearer file-key");
			assert.match(receivedBody, /What is xAI\?/);
			assert.strictEqual(result.content[0]?.type, "text");
			assert.strictEqual(result.content[0]?.text, "Done");
		});

		it("surfaces upstream API failures with status and body", async () => {
			const fetchImpl = async () => new Response(JSON.stringify({ error: "bad request" }), {
				status: 400,
				statusText: "Bad Request",
				headers: { "Content-Type": "application/json" },
			});
			const tool = createGrokSearchTool({
				apiKey: "xai-test-key",
				fetchImpl: fetchImpl as typeof fetch,
			});

			await assert.rejects(
				() => tool.execute("call-2", { query: "What is xAI?" }, undefined, undefined, {} as any),
				/400 Bad Request/
			);
			await assert.rejects(
				() => tool.execute("call-2", { query: "What is xAI?" }, undefined, undefined, {} as any),
				/bad request/
			);
		});

		it("reports aborts clearly", async () => {
			const controller = new AbortController();
			controller.abort();
			let called = false;
			const fetchImpl = async () => {
				called = true;
				return new Response(JSON.stringify({ output_text: "Nope" }));
			};
			const tool = createGrokSearchTool({
				apiKey: "xai-test-key",
				fetchImpl: fetchImpl as typeof fetch,
			});

			await assert.rejects(
				() => tool.execute("call-3", { query: "What is xAI?" }, controller.signal, undefined, {} as any),
				/aborted/
			);
			assert.strictEqual(called, false);
		});
	});

	describe("extension registration", () => {
		it("registers the grok_search tool", () => {
			const registeredTools: any[] = [];
			const pi = {
				registerTool(definition: any) {
					registeredTools.push(definition);
				},
			} as any;

			grokSearchExtension(pi);

			assert.strictEqual(registeredTools.length, 1);
			assert.strictEqual(registeredTools[0].name, TOOL_NAME);
			assert.strictEqual(registeredTools[0].label, "Grok Search");
		});
	});
});
