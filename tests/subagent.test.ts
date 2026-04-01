import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const subagentPkgPath = path.join(repoRoot, "extensions", "subagent", "package.json");
const subagentAgentsModulePath = path.join(repoRoot, "extensions", "subagent", "agents.ts");
const tsxBin =
	process.platform === "win32"
		? path.join(repoRoot, "node_modules", ".bin", "tsx.cmd")
		: path.join(repoRoot, "node_modules", ".bin", "tsx");

function writeAgent(filePath: string, name: string, description = `${name} description`): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: ${description}\n---\nYou are ${name}.\n`,
		"utf8",
	);
}

function runDiscovery(homeDir: string, cwd: string) {
	const moduleUrl = pathToFileURL(subagentAgentsModulePath).href;
	const code = `
		import { discoverAgents, discoverAgentsAll } from ${JSON.stringify(moduleUrl)};
		const cwd = process.cwd();
		const summarize = (result) => ({
			agents: result.agents.map((agent) => ({ name: agent.name, source: agent.source })),
			projectAgentsDir: result.projectAgentsDir,
		});
		const all = discoverAgentsAll(cwd);
		console.log(JSON.stringify({
			all: {
				builtin: all.builtin.map((agent) => ({ name: agent.name, source: agent.source })),
				user: all.user.map((agent) => ({ name: agent.name, source: agent.source })),
				project: all.project.map((agent) => ({ name: agent.name, source: agent.source })),
				chains: all.chains.map((chain) => ({ name: chain.name, source: chain.source })),
				userDir: all.userDir,
				projectDir: all.projectDir,
			},
			user: summarize(discoverAgents(cwd, "user")),
			project: summarize(discoverAgents(cwd, "project")),
			both: summarize(discoverAgents(cwd, "both")),
		}));
	`;

	const output = execFileSync(tsxBin, ["--eval", code], {
		cwd,
		env: {
			...process.env,
			HOME: homeDir,
		},
		encoding: "utf8",
	});

	return JSON.parse(output) as {
		all: {
			builtin: Array<{ name: string; source: string }>;
			user: Array<{ name: string; source: string }>;
			project: Array<{ name: string; source: string }>;
			chains: Array<{ name: string; source: string }>;
			userDir: string;
			projectDir: string | null;
		};
		user: { agents: Array<{ name: string; source: string }>; projectAgentsDir: string | null };
		project: { agents: Array<{ name: string; source: string }>; projectAgentsDir: string | null };
		both: { agents: Array<{ name: string; source: string }>; projectAgentsDir: string | null };
	};
}

describe("subagent extension", () => {
	it("loads both extension entrypoints", async () => {
		const runtime = await import(pathToFileURL(path.join(repoRoot, "extensions", "subagent", "index.ts")).href);
		const notify = await import(pathToFileURL(path.join(repoRoot, "extensions", "subagent", "notify.ts")).href);

		assert.equal(typeof runtime.default, "function");
		assert.equal(typeof notify.default, "function");
	});

	it("registers both runtime and notify entrypoints", () => {
		const pkg = JSON.parse(fs.readFileSync(subagentPkgPath, "utf8")) as {
			pi?: { extensions?: string[] };
		};

		assert.deepEqual(pkg.pi?.extensions, ["./index.ts", "./notify.ts"]);
		assert.equal(fs.existsSync(path.join(repoRoot, "extensions", "subagent", "agents")), false);
	});

	it("discovers only user and project agents when no builtin agents are shipped", () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kfrance-subagent-test-"));
		const homeDir = path.join(tmpRoot, "home");
		const projectDir = path.join(tmpRoot, "project");
		const projectAgentsDir = path.join(projectDir, ".pi", "agents");
		const nestedCwd = path.join(projectDir, "src", "feature");

		fs.mkdirSync(homeDir, { recursive: true });
		fs.mkdirSync(nestedCwd, { recursive: true });
		writeAgent(path.join(homeDir, ".pi", "agent", "agents", "user-agent.md"), "user-agent");
		writeAgent(path.join(projectAgentsDir, "project-agent.md"), "project-agent");

		const result = runDiscovery(homeDir, nestedCwd);
		const bothNames = result.both.agents.map((agent) => agent.name).sort();
		const bothSources = new Set(result.both.agents.map((agent) => agent.source));

		assert.deepEqual(result.all.builtin, []);
		assert.deepEqual(result.all.user, [{ name: "user-agent", source: "user" }]);
		assert.deepEqual(result.all.project, [{ name: "project-agent", source: "project" }]);
		assert.equal(result.all.projectDir, projectAgentsDir);
		assert.deepEqual(result.user.agents, [{ name: "user-agent", source: "user" }]);
		assert.deepEqual(result.project.agents, [{ name: "project-agent", source: "project" }]);
		assert.deepEqual(bothNames, ["project-agent", "user-agent"]);
		assert.deepEqual([...bothSources].sort(), ["project", "user"]);
		assert.equal(result.both.agents.some((agent) => agent.source === "builtin"), false);
	});
});
