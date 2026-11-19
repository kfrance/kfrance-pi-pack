/**
 * Filesystem Sandbox Extension for pi
 *
 * Uses @anthropic-ai/sandbox-runtime (bubblewrap on Linux, sandbox-exec on macOS)
 * for OS-level filesystem isolation on bash commands. No network filtering —
 * full network access is preserved.
 *
 * How it works:
 * - Mounts entire filesystem read-only (--ro-bind / /) for bash commands
 * - Selectively allows writes to configured paths (project dir, /tmp, etc.)
 * - Auto-denies writes to dangerous files (.bashrc, .gitconfig, git hooks, etc.)
 * - Unix sockets are allowed through the runtime's `allowAllUnixSockets` option
 *   (tools such as tsx need them for IPC). That turns off the runtime's seccomp
 *   filter, whose job is to block socket(AF_UNIX) so a command cannot talk to
 *   host services. Sockets that would let a command escape (the systemd user
 *   bus and other per-user agents under /run/user/<uid>, and the Docker socket)
 *   are hidden instead through the default denyRead list.
 * - Edit and Write tools are also sandboxed: paths are checked against
 *   allowWrite/denyWrite before the file operation is performed
 * - When a sandboxed bash command fails because a write was denied, the owner
 *   is asked `ctx.ui.confirm("Run outside the sandbox?", <command>)`. A yes
 *   reruns that same command once without the sandbox; a no returns the
 *   original failure with a note that the owner declined.
 *
 * Mode (environment variable PI_SANDBOX):
 * - PI_SANDBOX=required — enable regardless of config and fail closed: if the
 *   sandbox cannot start, bash/edit/write refuse to run.
 * - PI_SANDBOX=off      — never enable at session start.
 * - unset               — follow sandbox.json (below).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json  (global defaults)
 * - <cwd>/.pi/sandbox.json    (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
 *   }
 * }
 * ```
 *
 * Commands:
 * - /sandbox          — show current status and config
 * - /sandbox-on       — enable sandbox mid-session
 * - /sandbox-off      — disable sandbox mid-session (refused when required)
 * - /sandbox-add <p>  — add a writable path on the fly
 * - /sandbox-deny <p> — deny writes to a path on the fly
 *
 * Flags:
 * - --no-sandbox      — suppress auto-start even if config says enabled
 *                       (ignored when PI_SANDBOX=required)
 *
 * Requires: bubblewrap (bwrap), ripgrep (rg), socat
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createLocalBashOperations,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export interface FilesystemConfig {
	denyRead: string[];
	allowWrite: string[];
	denyWrite: string[];
}

interface SandboxJsonConfig {
	enabled?: boolean;
	filesystem?: Partial<FilesystemConfig>;
}

export type SandboxMode = "required" | "off" | "config";

/** The parts of SandboxManager this extension uses; injectable for tests. */
export type SandboxRuntime = Pick<
	typeof SandboxManager,
	| "isSupportedPlatform"
	| "checkDependencies"
	| "updateConfig"
	| "wrapWithSandbox"
	| "cleanupAfterCommand"
	| "annotateStderrWithSandboxFailures"
	| "reset"
>;

export interface SandboxExtensionOptions {
	runtime?: SandboxRuntime;
	/** Environment to read PI_SANDBOX from. Defaults to process.env. */
	env?: NodeJS.ProcessEnv;
}

// ============================================================================
// Defaults
// ============================================================================

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

export const DEFAULT_FILESYSTEM: FilesystemConfig = {
	denyRead: [
		"~/.ssh",
		"~/.aws",
		"~/.gnupg",
		"~/.pi/agent/auth.json",
		"~/.pi/agent/secrets",
		".env",
		".env.*",
		"*.pem",
		"*.key",
		// Unix sockets are allowed, so hide the ones that run commands outside
		// the sandbox: the systemd user bus (`systemd-run --user`), ssh/gpg
		// agents and other per-user services, and the Docker daemon.
		...(uid !== undefined ? [`/run/user/${uid}`] : []),
		"/var/run/docker.sock",
	],
	allowWrite: [".", "/tmp"],
	denyWrite: ["~/.pi/agent/auth.json", "~/.pi/agent/secrets"],
};

export const RERUN_CONFIRM_TITLE = "Run outside the sandbox?";
export const RERUN_DECLINED_LINE = "The owner declined running it outside the sandbox.";

// ============================================================================
// Mode and Config Loading
// ============================================================================

export function parseSandboxMode(value: string | undefined): { mode: SandboxMode; warning?: string } {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return { mode: "config" };
	if (normalized === "required") return { mode: "required" };
	if (normalized === "off") return { mode: "off" };
	// Fail closed on anything unexpected (for example a typo like "require").
	return { mode: "required", warning: `Unrecognized PI_SANDBOX value "${value}"; treating it as "required".` };
}

export function loadJsonConfig(path: string): SandboxJsonConfig {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`Warning: Could not parse ${path}: ${e}`);
		return {};
	}
}

export function mergeFilesystem(base: FilesystemConfig, override?: Partial<FilesystemConfig>): FilesystemConfig {
	if (!override) return { ...base };
	return {
		denyRead: override.denyRead ?? base.denyRead,
		allowWrite: override.allowWrite ?? base.allowWrite,
		denyWrite: override.denyWrite ?? base.denyWrite,
	};
}

/**
 * Load and merge config from global + project files.
 * Project config overrides global config, which overrides defaults.
 */
export function loadConfig(cwd: string): { enabled: boolean; filesystem: FilesystemConfig } {
	const globalPath = join(homedir(), ".pi", "agent", "sandbox.json");
	const projectPath = join(cwd, ".pi", "sandbox.json");

	const globalJson = loadJsonConfig(globalPath);
	const projectJson = loadJsonConfig(projectPath);

	// Merge: defaults -> global -> project
	const filesystem = mergeFilesystem(
		mergeFilesystem(DEFAULT_FILESYSTEM, globalJson.filesystem),
		projectJson.filesystem,
	);

	// enabled: project wins over global, default false if no config exists
	const hasAnyConfig = existsSync(globalPath) || existsSync(projectPath);
	const enabled = projectJson.enabled ?? globalJson.enabled ?? hasAnyConfig;

	return { enabled, filesystem };
}

// ============================================================================
// Path Checking for Edit/Write Sandboxing
// ============================================================================

/**
 * Expand ~ and @, then resolve relative to cwd.
 * Mirrors the logic in pi's built-in resolveToCwd / expandPath.
 */
export function expandAndResolve(filePath: string, cwd: string): string {
	let expanded = filePath;
	// Strip leading @ (pi convention)
	if (expanded.startsWith("@")) {
		expanded = expanded.slice(1);
	}
	if (expanded === "~") {
		expanded = homedir();
	} else if (expanded.startsWith("~/")) {
		expanded = homedir() + expanded.slice(1);
	}
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Resolve a path for sandbox checking, following symlinks to get the real
 * filesystem path. This prevents symlink traversal bypasses where a symlink
 * inside an allowed directory points outside it.
 *
 * For new files (write tool), resolves the nearest existing ancestor.
 */
export function resolvePathForCheck(filePath: string, cwd: string): string {
	const resolved = expandAndResolve(filePath, cwd);

	// Try to resolve the full path (works for existing files, including via symlinks)
	try {
		return realpathSync(resolved);
	} catch {
		// File doesn't exist (e.g. write creating a new file).
		// Resolve the nearest existing ancestor to catch symlinks in parent dirs.
		let current = dirname(resolved);
		const tail: string[] = [resolved.split("/").pop()!];
		while (current !== "/") {
			try {
				return realpathSync(current) + "/" + tail.join("/");
			} catch {
				tail.unshift(current.split("/").pop()!);
				current = dirname(current);
			}
		}
		return resolved;
	}
}

/**
 * Expand a config path pattern (handles ~ and . relative to cwd).
 * Returns an absolute path string.
 */
export function expandConfigPath(pattern: string, cwd: string): string {
	if (pattern === ".") return resolve(cwd);
	if (pattern === "~") return homedir();
	if (pattern.startsWith("~/")) return resolve(homedir(), pattern.slice(2));
	if (isAbsolute(pattern)) return resolve(pattern);
	// Relative path — resolve against cwd
	return resolve(cwd, pattern);
}

/**
 * Check if a path matches a deny pattern.
 * Supports:
 * - Glob-style basename patterns: *.ext, .env.*, exact basename (e.g. ".env")
 * - Directory path patterns: paths containing "/" are treated as directory prefixes
 *   (e.g. "secrets/", "./config", "~/private")
 */
export function matchesDenyPattern(absolutePath: string, pattern: string, cwd: string): boolean {
	// If the pattern looks like a path (contains /), treat it as a directory prefix
	if (pattern.includes("/") || pattern.startsWith("~") || pattern.startsWith(".")) {
		// But not bare dot-files like ".env" or ".env.*"
		if (!pattern.startsWith("./") && !pattern.startsWith("../") && !pattern.startsWith("~/") && !pattern.startsWith("/") && !pattern.endsWith("/")) {
			// It's a bare name like ".env" or ".env.*" — fall through to basename matching
		} else {
			const denyDir = expandAndResolve(pattern, cwd);
			return absolutePath === denyDir || absolutePath.startsWith(denyDir.replace(/\/$/, "") + "/");
		}
	}

	const basename = absolutePath.split("/").pop() || "";
	// *.ext pattern — match file extension
	if (pattern.startsWith("*.")) {
		return basename.endsWith(pattern.slice(1));
	}
	// prefix.* pattern (e.g. .env.*)
	if (pattern.endsWith(".*")) {
		const prefix = pattern.slice(0, -2);
		return basename.startsWith(prefix) && basename.length > prefix.length && basename[prefix.length] === ".";
	}
	// Exact basename match (e.g. ".env")
	return basename === pattern;
}

/**
 * Check whether a read from the given absolute path is allowed by the sandbox
 * filesystem config. denyRead is deny-only: all reads allowed unless denied.
 */
export function isReadAllowed(absolutePath: string, cwd: string, filesystem: FilesystemConfig = DEFAULT_FILESYSTEM): { allowed: boolean; reason?: string } {
	for (const pattern of filesystem.denyRead) {
		if (matchesDenyPattern(absolutePath, pattern, cwd)) {
			return { allowed: false, reason: `matches denyRead pattern: ${pattern}` };
		}
	}
	return { allowed: true };
}

/**
 * Check whether a write to the given absolute path is allowed by the sandbox
 * filesystem config.
 */
export function isWriteAllowed(absolutePath: string, cwd: string, filesystem: FilesystemConfig = DEFAULT_FILESYSTEM): { allowed: boolean; reason?: string } {
	// Check denyWrite patterns first (highest priority)
	for (const pattern of filesystem.denyWrite) {
		if (matchesDenyPattern(absolutePath, pattern, cwd)) {
			return { allowed: false, reason: `matches denyWrite pattern: ${pattern}` };
		}
	}

	// Check allowWrite paths — the file must be under at least one
	const allowed = filesystem.allowWrite.some((configPath) => {
		const allowedDir = expandConfigPath(configPath, cwd);
		return absolutePath === allowedDir || absolutePath.startsWith(allowedDir + "/");
	});

	if (!allowed) {
		return {
			allowed: false,
			reason: `path is outside allowed write directories: ${filesystem.allowWrite.join(", ")}`,
		};
	}

	return { allowed: true };
}

// ============================================================================
// Runtime config for a given cwd
// ============================================================================

/** The runtime's own cwd-relative write denies (it computes them from process.cwd()). */
const MANDATORY_DENY_NAMES = [
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".zshrc",
	".zprofile",
	".profile",
	".ripgreprc",
	".mcp.json",
	".vscode",
	".idea",
	".claude/commands",
	".claude/agents",
];

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
}

function cwdMandatoryDenies(cwd: string): string[] {
	const denies = MANDATORY_DENY_NAMES.map((name) => join(cwd, name));
	const dotGit = join(cwd, ".git");
	try {
		if (statSync(dotGit).isDirectory()) denies.push(join(dotGit, "hooks"), join(dotGit, "config"));
		else denies.push(dotGit);
	} catch {
		// No .git here
	}
	return denies;
}

/**
 * Resolve the config for one command run in `cwd`. The runtime resolves
 * relative entries (".", ".env") and its mandatory denies against
 * process.cwd(), which is not the tool's cwd when pi runs a conversation in
 * another folder (for example inside an SDK worker). So relative entries are
 * made absolute here, and the cwd's mandatory denies are added when the two
 * differ.
 */
export function resolveFilesystemForCwd(filesystem: FilesystemConfig, cwd: string, processCwd = process.cwd()): FilesystemConfig {
	const absolute = (entries: string[]) => entries.map((entry) => expandConfigPath(entry, cwd));
	const resolved = {
		denyRead: absolute(filesystem.denyRead),
		allowWrite: absolute(filesystem.allowWrite),
		denyWrite: absolute(filesystem.denyWrite),
	};
	if (!samePath(cwd, processCwd)) {
		resolved.denyWrite.push(...cwdMandatoryDenies(cwd));
	}
	return resolved;
}

// ============================================================================
// Write-denial detection (rerun prompt)
// ============================================================================

const QUOTED_PATH = /'([^'\n]+)'|"([^"\n]+)"|‘([^’\n]+)’|`([^`'\n]+)'/g;
const DENIAL_WORDS = /Permission denied|EACCES|Operation not permitted|EPERM/i;

function candidatePaths(line: string): string[] {
	const found: string[] = [];
	for (const match of line.matchAll(QUOTED_PATH)) {
		const value = match[1] ?? match[2] ?? match[3] ?? match[4];
		if (value) found.push(value);
	}
	for (const field of line.split(/:\s+/)) {
		const value = field.trim();
		if (/^(\/|~\/|\.\.?\/)/.test(value) && !/\s/.test(value)) found.push(value);
	}
	return found;
}

/**
 * Whether a failed sandboxed command's output shows that the sandbox denied a
 * write: a read-only file system error, a permission error on a path outside
 * allowWrite, or a violation report from the sandbox runtime.
 */
export function detectWriteDenial(output: string, cwd: string, filesystem: FilesystemConfig, violations?: string): boolean {
	if (violations?.includes("<sandbox_violations>")) return true;
	if (/Read-only file system|EROFS/.test(output)) return true;
	for (const line of output.split("\n")) {
		if (!DENIAL_WORDS.test(line)) continue;
		for (const candidate of candidatePaths(line)) {
			const absolutePath = resolvePathForCheck(candidate, cwd);
			if (!isWriteAllowed(absolutePath, cwd, filesystem).allowed) return true;
		}
	}
	return false;
}

const RECORD_LIMIT = 64 * 1024;

/** Keeps the tail of a command's raw output (decoded only if needed) and its runtime attribution id. */
class CommandRecord {
	private chunks: Buffer[] = [];
	private bytes = 0;
	commandId: string | undefined;

	append(data: Buffer) {
		this.chunks.push(data);
		this.bytes += data.length;
		while (this.chunks.length > 1 && this.bytes - this.chunks[0].length >= RECORD_LIMIT) {
			this.bytes -= this.chunks.shift()!.length;
		}
	}

	get output(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

function appendLine<T extends { content: Array<{ type: string; text?: string }> }>(result: T, line: string): T {
	const content = [...result.content];
	const last = content[content.length - 1];
	if (last?.type === "text") {
		content[content.length - 1] = { ...last, text: `${last.text ?? ""}\n\n${line}` };
	} else {
		content.push({ type: "text", text: line });
	}
	return { ...result, content };
}

// ============================================================================
// Status Helpers
// ============================================================================

export function formatConfig(active: boolean, filesystem: FilesystemConfig, mode: SandboxMode = "config", failure?: string): string {
	const lines = [
		`Status: ${active ? "ACTIVE" : "DISABLED"}`,
		`Mode: ${mode === "config" ? "sandbox.json" : `PI_SANDBOX=${mode}`}`,
		...(failure ? [`Unavailable: ${failure}`] : []),
		"",
		"Filesystem:",
		`  Allow Write: ${filesystem.allowWrite.join(", ") || "(none)"}`,
		`  Deny Read:   ${filesystem.denyRead.join(", ") || "(none)"}`,
		`  Deny Write:  ${filesystem.denyWrite.join(", ") || "(none)"}`,
		"",
		"Network: unrestricted (full access)",
		"Unix sockets: allowed, except the ones hidden by denyRead",
		"",
		"Protected tools: bash, read, edit, write",
		"  bash: OS-level bwrap isolation (read-only root + selective writes)",
		"  read: path checked against denyRead before execution",
		"  edit/write: path checked against allowWrite/denyWrite before execution",
		"",
		"Note: Writes to dangerous files (.bashrc, .gitconfig, git hooks,",
		"  .vscode, .idea, .claude/commands, etc.) are auto-denied by the sandbox",
		"  runtime even if not listed above (bash only).",
	];
	return lines.join("\n");
}

type UiContext = Pick<ExtensionContext, "ui">;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Extension
// ============================================================================

export function createSandboxExtension(options: SandboxExtensionOptions = {}) {
	const runtime: SandboxRuntime = options.runtime ?? SandboxManager;

	return function sandboxExtension(pi: ExtensionAPI) {
		const env = options.env ?? process.env;
		const { mode, warning: modeWarning } = parseSandboxMode(env.PI_SANDBOX);
		const localBash = createLocalBashOperations();

		let sandboxActive = false;
		let attempted = false;
		let failure: string | undefined;
		let currentFilesystem: FilesystemConfig = { ...DEFAULT_FILESYSTEM };
		let currentCtx: UiContext | undefined;

		function updateStatus(ctx: UiContext | undefined) {
			if (!ctx) return;
			if (!sandboxActive) {
				ctx.ui.setStatus("sandbox", mode === "required" ? ctx.ui.theme.fg("error", "Sandbox: unavailable") : undefined);
				return;
			}
			const w = currentFilesystem.allowWrite.length;
			const dr = currentFilesystem.denyRead.length;
			const dw = currentFilesystem.denyWrite.length;
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 Sandbox: ${w} write, ${dr} deny-read, ${dw} deny-write`));
		}

		/** Runs `true` in the sandbox, with the shell real commands use, so a broken bwrap shows up now. */
		async function probe(cwd: string): Promise<string | undefined> {
			const wrapped = await runtime.wrapWithSandbox("true", undefined, { filesystem: resolveFilesystemForCwd(currentFilesystem, cwd) });
			let output = "";
			try {
				const { exitCode } = await localBash.exec(wrapped, cwd, {
					onData: (data) => {
						output += data.toString("utf8");
					},
					timeout: 30,
				});
				return exitCode === 0 ? undefined : `sandbox test command failed (exit ${exitCode}): ${output.trim().slice(0, 300)}`;
			} finally {
				runtime.cleanupAfterCommand();
			}
		}

		/** Why the sandbox cannot start in `cwd`, or undefined when it started. */
		async function startFailure(cwd: string, ctx: UiContext | undefined): Promise<string | undefined> {
			if (!runtime.isSupportedPlatform()) return "sandbox is not supported on this platform";
			const deps = runtime.checkDependencies();
			if (deps.errors.length > 0) return `sandbox dependencies missing: ${deps.errors.join(", ")}`;
			if (deps.warnings.length > 0) ctx?.ui.notify(`Sandbox warnings: ${deps.warnings.join(", ")}`, "warning");
			try {
				// Install a session config without network.allowedDomains. The runtime
				// isolates the network only when allowedDomains is set (its schema
				// marks it required, hence the cast), so this keeps full network
				// access while allowAllUnixSockets skips the seccomp socket filter.
				// updateConfig, unlike initialize, starts no proxy servers. The real
				// bubblewrap tests check that network and Unix sockets still work.
				runtime.updateConfig({
					network: { allowAllUnixSockets: true, deniedDomains: [] },
					filesystem: resolveFilesystemForCwd(currentFilesystem, cwd),
				} as unknown as Parameters<SandboxRuntime["updateConfig"]>[0]);
				return await probe(cwd);
			} catch (error) {
				return errorText(error);
			}
		}

		async function enableSandbox(filesystem: FilesystemConfig, cwd: string, ctx: UiContext | undefined): Promise<boolean> {
			attempted = true;
			currentFilesystem = {
				denyRead: [...filesystem.denyRead],
				allowWrite: [...filesystem.allowWrite],
				denyWrite: [...filesystem.denyWrite],
			};

			failure = await startFailure(cwd, ctx);
			sandboxActive = failure === undefined;
			updateStatus(ctx);
			if (failure) {
				ctx?.ui.notify(
					mode === "required"
						? `Sandbox required but unavailable (${failure}). bash, edit and write will refuse to run.`
						: `Sandbox not enabled: ${failure}`,
					"error",
				);
				return false;
			}
			ctx?.ui.notify("Sandbox enabled", "info");
			return true;
		}

		async function disableSandbox() {
			sandboxActive = false;
			try {
				await runtime.reset();
			} catch {
				// Ignore cleanup errors
			}
		}

		/**
		 * Whether this tool call runs sandboxed. In required mode a sandbox that
		 * cannot start throws, so the tool refuses instead of running unsandboxed.
		 */
		async function useSandbox(ctx: ExtensionContext | undefined, tool: string): Promise<boolean> {
			if (mode !== "required") return sandboxActive;
			if (!sandboxActive && !attempted) {
				const cwd = ctx?.cwd ?? process.cwd();
				await enableSandbox(loadConfig(cwd).filesystem, cwd, ctx ?? currentCtx);
			}
			if (!sandboxActive) {
				throw new Error(
					`Refusing to run ${tool}: PI_SANDBOX=required but the sandbox is unavailable (${failure ?? "not started"}). ` +
						"Fix the sandbox (bubblewrap, ripgrep, socat) and restart.",
				);
			}
			return true;
		}

		function createSandboxedBashOps(record: CommandRecord): BashOperations {
			return {
				async exec(command, cwd, execOptions) {
					const commandId = randomUUID();
					record.commandId = commandId;
					const wrapped = await runtime.wrapWithSandbox(
						command,
						undefined,
						{ filesystem: resolveFilesystemForCwd(currentFilesystem, cwd) },
						execOptions.signal,
						{ commandId, commandText: command },
					);
					try {
						return await localBash.exec(wrapped, cwd, {
							...execOptions,
							onData: (data) => {
								record.append(data);
								execOptions.onData(data);
							},
						});
					} finally {
						// Clean up mount point files bwrap creates for non-existent deny paths
						runtime.cleanupAfterCommand();
					}
				},
			};
		}

		/**
		 * After a failed sandboxed command: undefined when no write was denied,
		 * otherwise the owner's answer to running `command` outside the sandbox.
		 * The message is exactly the command: my-claw turns it into the approval
		 * card's action.
		 */
		async function askRerun(record: CommandRecord, cwd: string, command: string, ctx: UiContext | undefined): Promise<boolean | undefined> {
			let violations: string | undefined;
			try {
				if (record.commandId) violations = runtime.annotateStderrWithSandboxFailures(record.commandId, "");
			} catch {
				// No violation report
			}
			if (!detectWriteDenial(record.output, cwd, currentFilesystem, violations)) return undefined;
			return ctx?.ui ? ctx.ui.confirm(RERUN_CONFIRM_TITLE, command) : false;
		}

		/** Throws the sandbox's refusal when `path` fails one of `checks`. */
		function checkPath(path: string, cwd: string, checks: Array<{ kind: "read" | "write"; label: string; hint?: string }>) {
			const absolutePath = resolvePathForCheck(path, cwd);
			for (const { kind, label, hint } of checks) {
				const check = (kind === "read" ? isReadAllowed : isWriteAllowed)(absolutePath, cwd, currentFilesystem);
				if (!check.allowed) throw new Error(`Sandbox blocked ${label} "${path}": ${check.reason}.${hint ? ` ${hint}` : ""}`);
			}
		}

		const ADD_HINT = "Use /sandbox-add <path> to allow.";

		// --no-sandbox flag to suppress auto-start
		pi.registerFlag("no-sandbox", {
			description: "Disable filesystem sandboxing even if config says enabled (ignored when PI_SANDBOX=required)",
			type: "boolean",
			default: false,
		});

		// The built-in tools resolve paths and run commands in ctx.cwd, which is
		// the conversation folder even when process.cwd() is somewhere else.
		const bashDefinition = createBashToolDefinition(process.cwd());
		pi.registerTool({
			...bashDefinition,
			label: "bash (sandbox-aware)",
			async execute(id, params, signal, onUpdate, ctx) {
				if (!(await useSandbox(ctx, "bash"))) return bashDefinition.execute(id, params, signal, onUpdate, ctx);

				const cwd = ctx?.cwd ?? process.cwd();
				const record = new CommandRecord();
				const sandboxed = createBashToolDefinition(cwd, { operations: createSandboxedBashOps(record) });
				const result = await sandboxed.execute(id, params, signal, onUpdate, ctx);
				if (!result.isError || signal?.aborted) return result;

				const approved = await askRerun(record, cwd, params.command, ctx);
				if (approved === undefined) return result;
				if (approved) return bashDefinition.execute(id, params, signal, onUpdate, ctx);
				return appendLine(result, RERUN_DECLINED_LINE);
			},
		});

		// Override read tool — enforce denyRead when sandbox is active (or required)
		const readDefinition = createReadToolDefinition(process.cwd());
		pi.registerTool({
			...readDefinition,
			label: "read (sandbox-aware)",
			async execute(id, params, signal, onUpdate, ctx) {
				if (sandboxActive || mode === "required") {
					checkPath(params.path, ctx?.cwd ?? process.cwd(), [{ kind: "read", label: "read of" }]);
				}
				return readDefinition.execute(id, params, signal, onUpdate, ctx);
			},
		});

		// Override edit tool — enforce denyRead + allowWrite/denyWrite when sandbox is active
		const editDefinition = createEditToolDefinition(process.cwd());
		pi.registerTool({
			...editDefinition,
			label: "edit (sandbox-aware)",
			async execute(id, params, signal, onUpdate, ctx) {
				if (await useSandbox(ctx, "edit")) {
					// Edit reads the file first, so check denyRead too
					checkPath(params.path, ctx?.cwd ?? process.cwd(), [
						{ kind: "read", label: "edit (read) of" },
						{ kind: "write", label: "edit to", hint: ADD_HINT },
					]);
				}
				return editDefinition.execute(id, params, signal, onUpdate, ctx);
			},
		});

		// Override write tool — enforce allowWrite/denyWrite when sandbox is active
		const writeDefinition = createWriteToolDefinition(process.cwd());
		pi.registerTool({
			...writeDefinition,
			label: "write (sandbox-aware)",
			async execute(id, params, signal, onUpdate, ctx) {
				if (await useSandbox(ctx, "write")) {
					checkPath(params.path, ctx?.cwd ?? process.cwd(), [{ kind: "write", label: "write to", hint: ADD_HINT }]);
				}
				return writeDefinition.execute(id, params, signal, onUpdate, ctx);
			},
		});

		// Hook user-typed bash commands (! and !!) too
		pi.on("user_bash", async (event, ctx) => {
			try {
				if (!(await useSandbox(ctx, "bash"))) return;
			} catch (error) {
				return { result: { output: errorText(error), exitCode: 1, cancelled: false, truncated: false } };
			}

			const operations: BashOperations = {
				async exec(command, cwd, execOptions) {
					const record = new CommandRecord();
					const result = await createSandboxedBashOps(record).exec(command, cwd, execOptions);
					if (result.exitCode === 0 || execOptions.signal?.aborted) return result;
					const approved = await askRerun(record, cwd, event.command, ctx);
					if (approved === undefined) return result;
					if (!approved) {
						execOptions.onData(Buffer.from(`\n${RERUN_DECLINED_LINE}\n`));
						return result;
					}
					execOptions.onData(Buffer.from("\n[running outside the sandbox]\n"));
					return localBash.exec(command, cwd, execOptions);
				},
			};
			return { operations };
		});

		// ========================================================================
		// Auto-start on session start
		// ========================================================================

		pi.on("session_start", async (_event, ctx) => {
			currentCtx = ctx;
			if (modeWarning) ctx.ui.notify(modeWarning, "warning");
			if (mode === "off") return;

			const noSandboxFlag = pi.getFlag("no-sandbox") as boolean;
			const config = loadConfig(ctx.cwd);
			if (mode === "required") {
				if (noSandboxFlag) ctx.ui.notify("--no-sandbox ignored: PI_SANDBOX=required", "warning");
				if (!sandboxActive) await enableSandbox(config.filesystem, ctx.cwd, ctx);
				return;
			}

			if (noSandboxFlag) {
				ctx.ui.notify("Sandbox suppressed via --no-sandbox", "info");
				return;
			}

			// No config or explicitly disabled — stay quiet
			if (config.enabled) await enableSandbox(config.filesystem, ctx.cwd, ctx);
		});

		// ========================================================================
		// Cleanup on shutdown
		// ========================================================================

		pi.on("session_shutdown", async () => {
			if (!sandboxActive) return;
			await disableSandbox();
			attempted = false;
		});

		// ========================================================================
		// Commands
		// ========================================================================

		pi.registerCommand("sandbox", {
			description: "Show sandbox status and configuration",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatConfig(sandboxActive, currentFilesystem, mode, failure), "info");
			},
		});

		pi.registerCommand("sandbox-on", {
			description: "Enable filesystem sandbox (loads config or uses defaults)",
			handler: async (_args, ctx) => {
				if (sandboxActive) {
					ctx.ui.notify("Sandbox is already active", "info");
					return;
				}
				await enableSandbox(loadConfig(ctx.cwd).filesystem, ctx.cwd, ctx);
			},
		});

		pi.registerCommand("sandbox-off", {
			description: "Disable filesystem sandbox",
			handler: async (_args, ctx) => {
				if (mode === "required") {
					ctx.ui.notify("Sandbox cannot be turned off: PI_SANDBOX=required", "error");
					return;
				}
				if (!sandboxActive) {
					ctx.ui.notify("Sandbox is already disabled", "info");
					return;
				}
				await disableSandbox();
				updateStatus(ctx);
				ctx.ui.notify("Sandbox disabled", "warning");
			},
		});

		/** Add `path` to a list of the active sandbox's config. */
		function addPath(list: "allowWrite" | "denyWrite", path: string): "inactive" | "exists" | "added" {
			if (!sandboxActive) return "inactive";
			if (currentFilesystem[list].includes(path)) return "exists";
			currentFilesystem[list].push(path);
			updateStatus(currentCtx);
			return "added";
		}

		function registerPathCommand(name: string, list: "allowWrite" | "denyWrite", description: string, addedMessage: string) {
			pi.registerCommand(name, {
				description,
				handler: async (args, ctx) => {
					const pathArg = args?.trim();
					if (!pathArg) {
						ctx.ui.notify(`Usage: /${name} <path>`, "error");
						return;
					}
					const outcome = addPath(list, pathArg);
					if (outcome === "inactive") ctx.ui.notify("Sandbox is not active. Use /sandbox-on first.", "error");
					else if (outcome === "exists") ctx.ui.notify(`Path already in ${list}: ${pathArg}`, "info");
					else {
						updateStatus(ctx);
						ctx.ui.notify(`${addedMessage}: ${pathArg}`, "info");
					}
				},
			});
		}

		registerPathCommand("sandbox-add", "allowWrite", "Add a writable path to the sandbox (e.g. /sandbox-add ~/projects/shared)", "Added writable path");
		registerPathCommand("sandbox-deny", "denyWrite", "Deny writes to a path (e.g. /sandbox-deny secrets/)", "Added write-denied path");

		// Listen for sandbox:add-path events from other extensions
		pi.events.on("sandbox:add-path", (data) => {
			const { path, result } = data as { path: string; result?: { handled: boolean } };
			const outcome = addPath("allowWrite", path);
			if (result) result.handled = true; // signal back that sandbox extension is loaded
			if (outcome !== "inactive") currentCtx?.ui.notify(`Sandbox: added writable path '${path}' (via event)`, "info");
		});

		// Listen for sandbox:deny-path events from other extensions
		pi.events.on("sandbox:deny-path", (data) => {
			const { path } = data as { path: string };
			if (addPath("denyWrite", path) === "added") {
				currentCtx?.ui.notify(`Sandbox: denied writable path '${path}' (via event)`, "info");
			}
		});
	};
}

export default createSandboxExtension();
