import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createSandboxExtension,
	DEFAULT_FILESYSTEM,
	detectWriteDenial,
	expandAndResolve,
	expandConfigPath,
	formatConfig,
	isReadAllowed,
	isWriteAllowed,
	loadJsonConfig,
	matchesDenyPattern,
	mergeFilesystem,
	parseSandboxMode,
	RERUN_CONFIRM_TITLE,
	RERUN_DECLINED_LINE,
	resolveFilesystemForCwd,
	type FilesystemConfig,
	type SandboxRuntime,
} from "../extensions/sandbox.ts";

const CWD = "/home/user/project";
const HOME = homedir();

describe("sandbox", () => {
	// ========================================================================
	// mergeFilesystem
	// ========================================================================

	describe("mergeFilesystem", () => {
		it("returns a copy of base when no override", () => {
			const result = mergeFilesystem(DEFAULT_FILESYSTEM);
			assert.deepStrictEqual(result, DEFAULT_FILESYSTEM);
			assert.notStrictEqual(result, DEFAULT_FILESYSTEM); // different object
		});

		it("returns a copy of base when override is undefined", () => {
			const result = mergeFilesystem(DEFAULT_FILESYSTEM, undefined);
			assert.deepStrictEqual(result, DEFAULT_FILESYSTEM);
		});

		it("overrides individual fields", () => {
			const result = mergeFilesystem(DEFAULT_FILESYSTEM, {
				allowWrite: ["/custom"],
			});
			assert.deepStrictEqual(result.allowWrite, ["/custom"]);
			assert.deepStrictEqual(result.denyRead, DEFAULT_FILESYSTEM.denyRead);
			assert.deepStrictEqual(result.denyWrite, DEFAULT_FILESYSTEM.denyWrite);
		});

		it("overrides all fields", () => {
			const result = mergeFilesystem(DEFAULT_FILESYSTEM, {
				denyRead: ["~/.ssh"],
				allowWrite: ["/a"],
				denyWrite: [".secret"],
			});
			assert.deepStrictEqual(result, {
				denyRead: ["~/.ssh"],
				allowWrite: ["/a"],
				denyWrite: [".secret"],
			});
		});
	});

	// ========================================================================
	// loadJsonConfig
	// ========================================================================

	describe("loadJsonConfig", () => {
		it("returns empty object for non-existent path", () => {
			const result = loadJsonConfig("/does/not/exist/sandbox.json");
			assert.deepStrictEqual(result, {});
		});
	});

	// ========================================================================
	// expandAndResolve
	// ========================================================================

	describe("expandAndResolve", () => {
		it("resolves relative path against cwd", () => {
			assert.strictEqual(expandAndResolve("foo/bar.txt", CWD), resolve(CWD, "foo/bar.txt"));
		});

		it("expands ~ to home directory", () => {
			assert.strictEqual(expandAndResolve("~", CWD), HOME);
		});

		it("expands ~/ prefix", () => {
			assert.strictEqual(expandAndResolve("~/docs/file.txt", CWD), HOME + "/docs/file.txt");
		});

		it("strips leading @ prefix", () => {
			assert.strictEqual(expandAndResolve("@foo/bar.txt", CWD), resolve(CWD, "foo/bar.txt"));
		});

		it("handles absolute paths", () => {
			assert.strictEqual(expandAndResolve("/tmp/test.txt", CWD), "/tmp/test.txt");
		});

		it("strips @ then expands ~", () => {
			assert.strictEqual(expandAndResolve("@~/test.txt", CWD), HOME + "/test.txt");
		});
	});

	// ========================================================================
	// expandConfigPath
	// ========================================================================

	describe("expandConfigPath", () => {
		it("expands . to cwd", () => {
			assert.strictEqual(expandConfigPath(".", CWD), resolve(CWD));
		});

		it("expands ~ to home", () => {
			assert.strictEqual(expandConfigPath("~", CWD), HOME);
		});

		it("expands ~/ paths", () => {
			assert.strictEqual(expandConfigPath("~/projects", CWD), resolve(HOME, "projects"));
		});

		it("expands ./ paths against cwd", () => {
			assert.strictEqual(expandConfigPath("./src", CWD), resolve(CWD, "src"));
		});

		it("passes through absolute paths", () => {
			assert.strictEqual(expandConfigPath("/tmp", CWD), "/tmp");
		});

		it("resolves relative paths against cwd", () => {
			assert.strictEqual(expandConfigPath("build", CWD), resolve(CWD, "build"));
		});
	});

	// ========================================================================
	// matchesDenyPattern
	// ========================================================================

	describe("matchesDenyPattern", () => {
		it("matches *.ext glob pattern", () => {
			assert.strictEqual(matchesDenyPattern("/some/path/secret.pem", "*.pem", CWD), true);
			assert.strictEqual(matchesDenyPattern("/some/path/secret.key", "*.pem", CWD), false);
		});

		it("matches .env.* pattern", () => {
			assert.strictEqual(matchesDenyPattern("/project/.env.local", ".env.*", CWD), true);
			assert.strictEqual(matchesDenyPattern("/project/.env.production", ".env.*", CWD), true);
			assert.strictEqual(matchesDenyPattern("/project/.env", ".env.*", CWD), false);
		});

		it("matches exact basename", () => {
			assert.strictEqual(matchesDenyPattern("/project/.env", ".env", CWD), true);
			assert.strictEqual(matchesDenyPattern("/project/.env.local", ".env", CWD), false);
		});

		it("matches ~/ directory prefix pattern", () => {
			assert.strictEqual(matchesDenyPattern(HOME + "/.ssh/id_rsa", "~/.ssh", CWD), true);
			assert.strictEqual(matchesDenyPattern(HOME + "/.ssh", "~/.ssh", CWD), true);
			assert.strictEqual(matchesDenyPattern(HOME + "/.config/test", "~/.ssh", CWD), false);
		});

		it("matches ./ directory prefix pattern", () => {
			assert.strictEqual(
				matchesDenyPattern(resolve(CWD, "secrets/key.pem"), "./secrets", CWD),
				true,
			);
			assert.strictEqual(
				matchesDenyPattern(resolve(CWD, "src/main.ts"), "./secrets", CWD),
				false,
			);
		});

		it("matches absolute directory prefix pattern", () => {
			assert.strictEqual(matchesDenyPattern("/etc/shadow", "/etc/", CWD), true);
			assert.strictEqual(matchesDenyPattern("/etc/passwd", "/etc/", CWD), true);
			assert.strictEqual(matchesDenyPattern("/tmp/test", "/etc/", CWD), false);
		});
	});

	// ========================================================================
	// isReadAllowed
	// ========================================================================

	describe("isReadAllowed", () => {
		const fs: FilesystemConfig = {
			denyRead: ["~/.ssh", "~/.aws", ".env", "*.pem"],
			allowWrite: ["."],
			denyWrite: [],
		};

		it("allows reads not matching any deny pattern", () => {
			const result = isReadAllowed("/project/src/main.ts", CWD, fs);
			assert.strictEqual(result.allowed, true);
		});

		it("denies reads matching denyRead pattern", () => {
			const result = isReadAllowed(HOME + "/.ssh/id_rsa", CWD, fs);
			assert.strictEqual(result.allowed, false);
			assert.ok(result.reason?.includes("~/.ssh"));
		});

		it("denies reads from pi secret directories", () => {
			const result = isReadAllowed(HOME + "/.pi/agent/secrets/kfrance-pi-pack.env", CWD, {
				...fs,
				denyRead: [...fs.denyRead, "~/.pi/agent/secrets"],
			});
			assert.strictEqual(result.allowed, false);
			assert.ok(result.reason?.includes("~/.pi/agent/secrets"));
		});

		it("denies reads matching basename pattern", () => {
			const result = isReadAllowed("/project/.env", CWD, fs);
			assert.strictEqual(result.allowed, false);
		});

		it("denies reads matching glob pattern", () => {
			const result = isReadAllowed("/project/cert.pem", CWD, fs);
			assert.strictEqual(result.allowed, false);
		});
	});

	// ========================================================================
	// isWriteAllowed
	// ========================================================================

	describe("isWriteAllowed", () => {
		const fs: FilesystemConfig = {
			denyRead: [],
			allowWrite: [".", "/tmp"],
			denyWrite: [".env", "*.key"],
		};

		it("allows writes inside allowWrite directories", () => {
			const result = isWriteAllowed(resolve(CWD, "src/file.ts"), CWD, fs);
			assert.strictEqual(result.allowed, true);
		});

		it("allows writes to /tmp", () => {
			const result = isWriteAllowed("/tmp/output.txt", CWD, fs);
			assert.strictEqual(result.allowed, true);
		});

		it("denies writes outside allowWrite directories", () => {
			const result = isWriteAllowed("/etc/passwd", CWD, fs);
			assert.strictEqual(result.allowed, false);
			assert.ok(result.reason?.includes("outside allowed write"));
		});

		it("denies writes matching denyWrite even if inside allowWrite", () => {
			const result = isWriteAllowed(resolve(CWD, ".env"), CWD, fs);
			assert.strictEqual(result.allowed, false);
			assert.ok(result.reason?.includes("denyWrite"));
		});

		it("denies writes matching denyWrite glob pattern", () => {
			const result = isWriteAllowed(resolve(CWD, "server.key"), CWD, fs);
			assert.strictEqual(result.allowed, false);
		});

		it("denyWrite takes priority over allowWrite", () => {
			// .env is inside CWD (allowWrite: ".") but matches denyWrite ".env"
			const result = isWriteAllowed(resolve(CWD, ".env"), CWD, fs);
			assert.strictEqual(result.allowed, false);
		});
	});

	// ========================================================================
	// formatConfig
	// ========================================================================

	describe("formatConfig", () => {
		it("shows ACTIVE status when active", () => {
			const output = formatConfig(true, DEFAULT_FILESYSTEM);
			assert.ok(output.includes("Status: ACTIVE"));
		});

		it("shows DISABLED status when inactive", () => {
			const output = formatConfig(false, DEFAULT_FILESYSTEM);
			assert.ok(output.includes("Status: DISABLED"));
		});

		it("includes filesystem config details", () => {
			const fs: FilesystemConfig = {
				denyRead: ["~/.ssh"],
				allowWrite: [".", "/tmp"],
				denyWrite: [".secret"],
			};
			const output = formatConfig(true, fs);
			assert.ok(output.includes("~/.ssh"));
			assert.ok(output.includes("/tmp"));
			assert.ok(output.includes(".secret"));
		});

		it("shows (none) for empty arrays", () => {
			const fs: FilesystemConfig = {
				denyRead: [],
				allowWrite: [],
				denyWrite: [],
			};
			const output = formatConfig(false, fs);
			assert.ok(output.includes("(none)"));
		});

		it("mentions network is unrestricted", () => {
			const output = formatConfig(true, DEFAULT_FILESYSTEM);
			assert.ok(output.includes("unrestricted"));
		});
	});

	// ========================================================================
	// DEFAULT_FILESYSTEM
	// ========================================================================

	describe("DEFAULT_FILESYSTEM", () => {
		it("has sensible defaults", () => {
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("~/.ssh"));
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("~/.aws"));
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("~/.gnupg"));
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("~/.pi/agent/auth.json"));
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("~/.pi/agent/secrets"));
			assert.ok(DEFAULT_FILESYSTEM.allowWrite.includes("."));
			assert.ok(DEFAULT_FILESYSTEM.allowWrite.includes("/tmp"));
			assert.ok(DEFAULT_FILESYSTEM.denyWrite.includes("~/.pi/agent/auth.json"));
			assert.ok(DEFAULT_FILESYSTEM.denyWrite.includes("~/.pi/agent/secrets"));
		});
	});

	describe("DEFAULT_FILESYSTEM escape sockets", () => {
		it("hides the per-user runtime dir and the Docker socket", () => {
			if (typeof process.getuid === "function") {
				assert.ok(DEFAULT_FILESYSTEM.denyRead.includes(`/run/user/${process.getuid()}`));
			}
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("/var/run/docker.sock"));
		});
	});

	// ========================================================================
	// parseSandboxMode
	// ========================================================================

	describe("parseSandboxMode", () => {
		it("reads required, off and unset", () => {
			assert.deepStrictEqual(parseSandboxMode("required"), { mode: "required" });
			assert.deepStrictEqual(parseSandboxMode("off"), { mode: "off" });
			assert.deepStrictEqual(parseSandboxMode(undefined), { mode: "config" });
			assert.deepStrictEqual(parseSandboxMode(""), { mode: "config" });
		});

		it("fails closed on unknown values", () => {
			const result = parseSandboxMode("require");
			assert.strictEqual(result.mode, "required");
			assert.ok(result.warning?.includes("require"));
		});
	});

	// ========================================================================
	// resolveFilesystemForCwd
	// ========================================================================

	describe("resolveFilesystemForCwd", () => {
		const fs: FilesystemConfig = { denyRead: [".env", "~/.ssh"], allowWrite: [".", "/tmp"], denyWrite: ["secrets"] };

		it("makes relative entries absolute against the tool cwd", () => {
			const resolved = resolveFilesystemForCwd(fs, "/work/conv", "/work/conv");
			assert.deepStrictEqual(resolved.allowWrite, ["/work/conv", "/tmp"]);
			assert.deepStrictEqual(resolved.denyRead, ["/work/conv/.env", resolve(HOME, ".ssh")]);
			assert.deepStrictEqual(resolved.denyWrite, ["/work/conv/secrets"]);
		});

		it("adds the cwd's mandatory denies when pi's cwd differs from the process cwd", () => {
			const resolved = resolveFilesystemForCwd(fs, "/work/conv", "/somewhere/else");
			assert.ok(resolved.denyWrite.includes("/work/conv/.bashrc"));
			assert.ok(resolved.denyWrite.includes("/work/conv/.claude/commands"));
		});
	});

	// ========================================================================
	// detectWriteDenial
	// ========================================================================

	describe("detectWriteDenial", () => {
		const fs: FilesystemConfig = { denyRead: [], allowWrite: ["."], denyWrite: [] };

		it("detects read-only file system errors", () => {
			assert.ok(detectWriteDenial("touch: cannot touch '/x': Read-only file system", CWD, fs));
		});

		it("detects permission errors on paths outside allowWrite", () => {
			assert.ok(detectWriteDenial("bash: /etc/hosts: Permission denied", CWD, fs));
			assert.ok(detectWriteDenial("Error: EACCES: permission denied, open '/opt/x.txt'", CWD, fs));
			assert.ok(detectWriteDenial("mkdir: cannot create directory ‘/srv/new’: Permission denied", CWD, fs));
		});

		it("ignores permission errors inside allowWrite and unrelated failures", () => {
			assert.ok(!detectWriteDenial(`bash: ${CWD}/script.sh: Permission denied`, CWD, fs));
			assert.ok(!detectWriteDenial("grep: no match", CWD, fs));
		});

		it("counts a runtime violation report", () => {
			assert.ok(detectWriteDenial("", CWD, fs, "<sandbox_violations>deny file-write /x</sandbox_violations>"));
		});
	});

	// ========================================================================
	// Extension behavior
	// ========================================================================

	describe("extension", () => {
		it("required mode with unavailable dependencies blocks bash, edit and write", async () => {
			const dir = makeTempDir();
			try {
				const marker = join(dir, "ran.txt");
				const harness = loadExtension({ PI_SANDBOX: "required" }, fakeRuntime({ depsErrors: ["bubblewrap (bwrap) not installed"] }));
				const { ctx } = createCtx(dir, true);
				await harness.emit("session_start", {}, ctx);

				await assert.rejects(
					harness.tools.get("bash").execute("1", { command: `touch ${marker}` }, undefined, undefined, ctx),
					/Refusing to run bash: PI_SANDBOX=required.*bubblewrap/,
				);
				await assert.rejects(
					harness.tools.get("write").execute("2", { path: marker, content: "x" }, undefined, undefined, ctx),
					/Refusing to run write/,
				);
				writeFileSync(join(dir, "edit-me.txt"), "hello");
				await assert.rejects(
					harness.tools.get("edit").execute("3", { path: "edit-me.txt", edits: [{ oldText: "hello", newText: "bye" }] }, undefined, undefined, ctx),
					/Refusing to run edit/,
				);
				assert.ok(!existsSync(marker), "nothing ran unsandboxed");
				assert.strictEqual(readFileSync(join(dir, "edit-me.txt"), "utf8"), "hello");

				const userBash = await harness.emit("user_bash", { command: `touch ${marker}`, cwd: dir, excludeFromContext: false }, ctx);
				assert.match(userBash.result.output, /Refusing to run bash/);
				assert.ok(!existsSync(marker));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("required mode refuses even before session_start ran", async () => {
			const dir = makeTempDir();
			try {
				const harness = loadExtension({ PI_SANDBOX: "required" }, fakeRuntime({ supported: false }));
				const { ctx } = createCtx(dir, true);
				await assert.rejects(
					harness.tools.get("bash").execute("1", { command: "true" }, undefined, undefined, ctx),
					/not supported on this platform/,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("asks to rerun a denied write and runs the same command once on yes", async () => {
			const dir = makeTempDir();
			try {
				const log = join(dir, "log.txt");
				const command = `echo run >> ${log}`;
				const harness = loadExtension({ PI_SANDBOX: "required" }, fakeRuntime({ deny: true }));
				const { ctx, confirms } = createCtx(dir, true);
				await harness.emit("session_start", {}, ctx);

				const result = await harness.tools.get("bash").execute("1", { command }, undefined, undefined, ctx);
				assert.deepStrictEqual(confirms, [[RERUN_CONFIRM_TITLE, command]]);
				assert.ok(!result.isError);
				assert.strictEqual(readFileSync(log, "utf8"), "run\n");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("returns the original failure plus a refusal line on no", async () => {
			const dir = makeTempDir();
			try {
				const log = join(dir, "log.txt");
				const command = `echo run >> ${log}`;
				const harness = loadExtension({ PI_SANDBOX: "required" }, fakeRuntime({ deny: true }));
				const { ctx, confirms } = createCtx(dir, false);
				await harness.emit("session_start", {}, ctx);

				const result = await harness.tools.get("bash").execute("1", { command }, undefined, undefined, ctx);
				assert.deepStrictEqual(confirms, [[RERUN_CONFIRM_TITLE, command]]);
				assert.strictEqual(result.isError, true);
				const text = result.content.map((c: { text?: string }) => c.text ?? "").join("\n");
				assert.match(text, /Read-only file system/);
				assert.ok(text.endsWith(RERUN_DECLINED_LINE));
				assert.ok(!existsSync(log));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("does not ask when a sandboxed command fails for another reason", async () => {
			const dir = makeTempDir();
			try {
				const harness = loadExtension({ PI_SANDBOX: "required" }, fakeRuntime({}));
				const { ctx, confirms } = createCtx(dir, true);
				await harness.emit("session_start", {}, ctx);
				const result = await harness.tools.get("bash").execute("1", { command: "echo nope >&2; exit 3" }, undefined, undefined, ctx);
				assert.strictEqual(result.isError, true);
				assert.deepStrictEqual(confirms, []);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// ========================================================================
	// Real bubblewrap
	// ========================================================================

	describe("with bubblewrap", { skip: bwrapUnavailableReason() }, () => {
		function setupProject() {
			const root = makeTempDir();
			const project = join(root, "project");
			const outside = join(root, "outside");
			mkdirSync(join(project, ".pi"), { recursive: true });
			mkdirSync(outside);
			writeFileSync(join(project, ".pi", "sandbox.json"), JSON.stringify({ enabled: true, filesystem: { allowWrite: ["."] } }));
			return { root, project, outside };
		}

		it("denies a write outside allowWrite and allows one inside", async () => {
			const { root, project, outside } = setupProject();
			try {
				const harness = loadExtension({}, undefined);
				const { ctx, confirms } = createCtx(project, false);
				await harness.emit("session_start", {}, ctx);

				const target = join(outside, "denied.txt");
				const denied = await harness.tools.get("bash").execute("1", { command: `touch ${target}` }, undefined, undefined, ctx);
				assert.strictEqual(denied.isError, true);
				assert.ok(!existsSync(target));
				assert.deepStrictEqual(confirms, [[RERUN_CONFIRM_TITLE, `touch ${target}`]]);

				const allowed = await harness.tools.get("bash").execute("2", { command: "touch inside.txt && echo ok" }, undefined, undefined, ctx);
				assert.ok(!allowed.isError);
				assert.ok(existsSync(join(project, "inside.txt")));

				await assert.rejects(
					harness.tools.get("write").execute("3", { path: join(outside, "w.txt"), content: "x" }, undefined, undefined, ctx),
					/Sandbox blocked write/,
				);
				await harness.emit("session_shutdown", {}, ctx);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("keeps the host network namespace and allows Unix sockets, but hides the user bus", async () => {
			const { root, project } = setupProject();
			try {
				const harness = loadExtension({}, undefined);
				const { ctx } = createCtx(project, false);
				await harness.emit("session_start", {}, ctx);
				const hostNet = spawnSync("readlink", ["/proc/self/ns/net"], { encoding: "utf8" }).stdout.trim();
				const sock = join(project, "t.sock");
				const command = [
					"readlink /proc/self/ns/net",
					`${process.execPath} -e "require('net').createServer().listen('${sock}', function () { console.log('unix-ok'); this.close(); })"`,
					typeof process.getuid === "function" ? `test -e /run/user/${process.getuid()}/bus && echo bus-visible || echo bus-hidden` : "echo bus-hidden",
				].join("; ");
				const result = await harness.tools.get("bash").execute("1", { command }, undefined, undefined, ctx);
				const text = result.content.map((c: { text?: string }) => c.text ?? "").join("\n");
				assert.ok(text.includes(hostNet), `same network namespace: ${text}`);
				assert.match(text, /unix-ok/);
				assert.match(text, /bus-hidden/);
				await harness.emit("session_shutdown", {}, ctx);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("reruns a denied command once outside the sandbox when approved", async () => {
			const { root, project, outside } = setupProject();
			try {
				const harness = loadExtension({}, undefined);
				const { ctx } = createCtx(project, true);
				await harness.emit("session_start", {}, ctx);
				const log = join(outside, "log.txt");
				const result = await harness.tools.get("bash").execute("1", { command: `echo run >> ${log}` }, undefined, undefined, ctx);
				assert.ok(!result.isError);
				assert.strictEqual(readFileSync(log, "utf8"), "run\n");
				await harness.emit("session_shutdown", {}, ctx);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("PI_SANDBOX=off leaves tools unsandboxed even when config enables the sandbox", async () => {
			const { root, project, outside } = setupProject();
			try {
				const harness = loadExtension({ PI_SANDBOX: "off" }, undefined);
				const { ctx, confirms } = createCtx(project, false);
				await harness.emit("session_start", {}, ctx);

				const target = join(outside, "free.txt");
				const result = await harness.tools.get("bash").execute("1", { command: `touch ${target}` }, undefined, undefined, ctx);
				assert.ok(!result.isError);
				assert.ok(existsSync(target));
				await harness.tools.get("write").execute("2", { path: join(outside, "w.txt"), content: "x" }, undefined, undefined, ctx);
				assert.strictEqual(readFileSync(join(outside, "w.txt"), "utf8"), "x");
				assert.deepStrictEqual(confirms, []);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	});
});

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-sandbox-test-"));
}

function bwrapUnavailableReason(): string | false {
	const result = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "true"], { encoding: "utf8" });
	if (result.error) return `bwrap not runnable: ${result.error.message}`;
	return result.status === 0 ? false : `bwrap failed: ${result.stderr.trim()}`;
}

function fakeRuntime(options: { depsErrors?: string[]; supported?: boolean; deny?: boolean }): SandboxRuntime {
	const denial = `echo "touch: cannot touch '/outside/x': Read-only file system" >&2; exit 1`;
	return {
		isSupportedPlatform: () => options.supported ?? true,
		checkDependencies: () => ({ errors: options.depsErrors ?? [], warnings: [] }),
		updateConfig: () => {},
		wrapWithSandbox: async (command: string) => (command === "true" || !options.deny ? command : denial),
		cleanupAfterCommand: () => {},
		annotateStderrWithSandboxFailures: () => "",
		reset: async () => {},
	} as unknown as SandboxRuntime;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function loadExtension(env: NodeJS.ProcessEnv, runtime: SandboxRuntime | undefined) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const flags = new Map<string, unknown>();
	const pi = {
		registerFlag: (name: string, opts: { default?: unknown }) => flags.set(name, opts.default),
		getFlag: (name: string) => flags.get(name),
		registerTool: (definition: { name: string }) => tools.set(definition.name, definition),
		registerCommand: () => {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		events: { on: () => {} },
	};
	createSandboxExtension({ env, runtime })(pi as any);
	return {
		tools,
		async emit(event: string, payload: object, ctx: unknown): Promise<any> {
			let last: unknown;
			for (const handler of handlers.get(event) ?? []) last = await handler({ type: event, ...payload }, ctx);
			return last;
		},
	};
}

function createCtx(cwd: string, answer: boolean) {
	const confirms: Array<[string, string]> = [];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: undefined,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
		ui: {
			confirm: async (title: string, message: string) => {
				confirms.push([title, message]);
				return answer;
			},
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	return { ctx: ctx as any, confirms };
}
