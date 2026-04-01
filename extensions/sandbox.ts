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
 * - Auto-denies writes to dangerous files (.bashrc, .gitconfig, .env, git hooks, etc.)
 * - Handles symlinks, git worktrees, non-existent paths, and other edge cases
 * - Seccomp Unix socket filter is disabled at startup for tool compatibility (tsx, etc.)
 * - Edit and Write tools are also sandboxed: paths are checked against
 *   allowWrite/denyWrite before the file operation is performed
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
 * - /sandbox-off      — disable sandbox mid-session
 * - /sandbox-add <p>  — add a writable path on the fly
 * - /sandbox-deny <p> — deny writes to a path on the fly
 *
 * Flags:
 * - --no-sandbox      — suppress auto-start even if config says enabled
 *
 * Setup:
 * 1. Install this pi package (npm link or pi install)
 * 2. Requires: bubblewrap (bwrap), ripgrep (rg), optionally socat
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool, createReadTool, createEditTool, createWriteTool } from "@mariozechner/pi-coding-agent";

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

// ============================================================================
// Defaults
// ============================================================================

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
	],
	allowWrite: [".", "/tmp"],
	denyWrite: ["~/.pi/agent/auth.json", "~/.pi/agent/secrets"],
};

// ============================================================================
// Config Loading
// ============================================================================

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
	const enabled = projectJson.enabled ?? globalJson.enabled ?? (hasAnyConfig ? true : false);

	return { enabled, filesystem };
}

// ============================================================================
// Sandbox State
// ============================================================================

let sandboxActive = false;
let currentFilesystem: FilesystemConfig = { ...DEFAULT_FILESYSTEM };
let currentCtx: any = undefined;

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
	if (pattern.startsWith("./") || pattern === ".") return resolve(cwd, pattern);
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
 * Check whether a read from the given absolute path is allowed
 * by the current sandbox filesystem config.
 * denyRead uses a deny-only pattern (all reads allowed unless explicitly denied).
 */
export function isReadAllowed(absolutePath: string, cwd: string, filesystem?: FilesystemConfig): { allowed: boolean; reason?: string } {
	const fs = filesystem ?? currentFilesystem;
	for (const pattern of fs.denyRead) {
		if (matchesDenyPattern(absolutePath, pattern, cwd)) {
			return { allowed: false, reason: `matches denyRead pattern: ${pattern}` };
		}
	}
	return { allowed: true };
}

/**
 * Check whether a write to the given absolute path is allowed
 * by the current sandbox filesystem config.
 */
export function isWriteAllowed(absolutePath: string, cwd: string, filesystem?: FilesystemConfig): { allowed: boolean; reason?: string } {
	const fs = filesystem ?? currentFilesystem;
	// Check denyWrite patterns first (highest priority)
	for (const pattern of fs.denyWrite) {
		if (matchesDenyPattern(absolutePath, pattern, cwd)) {
			return { allowed: false, reason: `matches denyWrite pattern: ${pattern}` };
		}
	}

	// Check allowWrite paths — the file must be under at least one
	const allowed = fs.allowWrite.some((configPath) => {
		const allowedDir = expandConfigPath(configPath, cwd);
		return absolutePath === allowedDir || absolutePath.startsWith(allowedDir + "/");
	});

	if (!allowed) {
		return {
			allowed: false,
			reason: `path is outside allowed write directories: ${fs.allowWrite.join(", ")}`,
		};
	}

	return { allowed: true };
}

// ============================================================================
// Sandboxed Bash Operations
// ============================================================================

/**
 * Create BashOperations that wrap commands with bwrap via SandboxManager.
 *
 * Key design: we call SandboxManager.wrapWithSandbox() with ONLY filesystem
 * config (no network config). This means:
 * - needsNetworkRestriction = false → no --unshare-net, full network access
 * - Filesystem isolation is fully active (read-only root + selective writes)
 * - Seccomp may apply for Unix socket blocking (degrades gracefully if unavailable)
 * - Dangerous files are auto-denied via ripgrep scanning
 */
function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			// Wrap the command with bwrap. Only pass filesystem config —
			// omitting network config means no network restriction.
			const wrappedCommand = await SandboxManager.wrapWithSandbox(
				command,
				undefined, // binShell — use default (bash)
				{ filesystem: currentFilesystem }, // no network key = full network access
			);

			try {
				return await new Promise((resolve, reject) => {
					const child = spawn("bash", ["-c", wrappedCommand], {
						cwd,
						detached: true,
						stdio: ["ignore", "pipe", "pipe"],
					});

					let timedOut = false;
					let timeoutHandle: NodeJS.Timeout | undefined;

					if (timeout !== undefined && timeout > 0) {
						timeoutHandle = setTimeout(() => {
							timedOut = true;
							if (child.pid) {
								try {
									process.kill(-child.pid, "SIGKILL");
								} catch {
									child.kill("SIGKILL");
								}
							}
						}, timeout * 1000);
					}

					child.stdout?.on("data", onData);
					child.stderr?.on("data", onData);

					child.on("error", (err) => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						reject(err);
					});

					const onAbort = () => {
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					};

					signal?.addEventListener("abort", onAbort, { once: true });

					child.on("close", (code) => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						signal?.removeEventListener("abort", onAbort);

						if (signal?.aborted) {
							reject(new Error("aborted"));
						} else if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
						} else {
							resolve({ exitCode: code });
						}
					});
				});
			} finally {
				// Clean up mount point files bwrap creates for non-existent deny paths
				SandboxManager.cleanupAfterCommand();
			}
		},
	};
}

// ============================================================================
// Status Helpers
// ============================================================================

function updateStatus(ctx: { ui: { setStatus: (id: string, text: string) => void; theme: any } }) {
	if (!sandboxActive) {
		ctx.ui.setStatus("sandbox", "");
		return;
	}
	const w = currentFilesystem.allowWrite.length;
	const dr = currentFilesystem.denyRead.length;
	const dw = currentFilesystem.denyWrite.length;
	ctx.ui.setStatus(
		"sandbox",
		ctx.ui.theme.fg("accent", `🔒 Sandbox: ${w} write, ${dr} deny-read, ${dw} deny-write`),
	);
}

export function formatConfig(active?: boolean, filesystem?: FilesystemConfig): string {
	const isActive = active ?? sandboxActive;
	const fs = filesystem ?? currentFilesystem;
	const lines = [
		`Status: ${isActive ? "ACTIVE" : "DISABLED"}`,
		"",
		"Filesystem:",
		`  Allow Write: ${fs.allowWrite.join(", ") || "(none)"}`,
		`  Deny Read:   ${fs.denyRead.join(", ") || "(none)"}`,
		`  Deny Write:  ${fs.denyWrite.join(", ") || "(none)"}`,
		"",
		"Network: unrestricted (full access)",
		"",
		"Protected tools: bash, read, edit, write",
		"  bash: OS-level bwrap isolation (read-only root + selective writes)",
		"  read: path checked against denyRead before execution",
		"  edit/write: path checked against allowWrite/denyWrite before execution",
		"",
		"Note: Writes to dangerous files (.bashrc, .gitconfig, .env, git hooks,",
		"  .vscode, .idea, .claude/commands, etc.) are auto-denied by the sandbox",
		"  runtime even if not listed above (bash only).",
	];
	return lines.join("\n");
}

// ============================================================================
// Initialization
// ============================================================================

function checkDeps(ctx: { ui: { notify: (msg: string, level: string) => void } }): boolean {
	if (!SandboxManager.isSupportedPlatform()) {
		ctx.ui.notify("Sandbox not supported on this platform", "error");
		return false;
	}

	const deps = SandboxManager.checkDependencies();
	if (deps.errors.length > 0) {
		ctx.ui.notify(`Sandbox dependencies missing: ${deps.errors.join(", ")}`, "error");
		return false;
	}
	if (deps.warnings.length > 0) {
		ctx.ui.notify(`Sandbox warnings: ${deps.warnings.join(", ")}`, "warning");
	}
	return true;
}

/**
 * Replace apply-seccomp binaries with no-op shell scripts that skip the
 * seccomp filter and just exec the command. This allows Unix socket creation
 * (needed by tools like tsx for IPC pipes) while keeping all other sandbox
 * protections (bwrap filesystem isolation, read/write path enforcement).
 *
 * The runtime's API conflates allowAllUnixSockets with network restriction,
 * so there's no clean config-only way to disable the seccomp filter without
 * also triggering --unshare-net.
 */
function neutralizeSeccompBinaries(): void {
	const noopScript = '#!/bin/bash\n# No-op: skip seccomp filter (arg1=bpf), exec remaining args\nshift\nexec "$@"\n';
	try {
		const runtimeDir = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
		const arches = ["x64", "arm64"];
		for (const arch of arches) {
			for (const base of ["vendor", join("dist", "vendor")]) {
				const binaryPath = join(runtimeDir, base, "seccomp", arch, "apply-seccomp");
				if (!existsSync(binaryPath)) continue;
				// Check if already replaced (shell scripts start with #!)
				const { readFileSync, writeFileSync, chmodSync } = require("fs");
				const head = readFileSync(binaryPath, { encoding: null }).subarray(0, 2).toString();
				if (head === "#!") continue; // already a no-op script
				writeFileSync(binaryPath, noopScript);
				chmodSync(binaryPath, 0o755);
			}
		}
	} catch {
		// Non-fatal — seccomp filter will still apply
	}
}

function enableSandbox(
	filesystem: FilesystemConfig,
	ctx: { ui: { notify: (msg: string, level: string) => void; setStatus: (id: string, text: string) => void; theme: any } },
): boolean {
	if (!checkDeps(ctx)) return false;

	neutralizeSeccompBinaries();
	currentFilesystem = { ...filesystem };
	sandboxActive = true;
	updateStatus(ctx);
	ctx.ui.notify("Sandbox enabled", "success");
	return true;
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
	// --no-sandbox flag to suppress auto-start
	pi.registerFlag("no-sandbox", {
		description: "Disable filesystem sandboxing even if config says enabled",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	// Override the LLM's bash tool — sandboxed when active, normal when not
	pi.registerTool({
		...localBash,
		label: "bash (sandbox-aware)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxActive) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	// Override read tool — enforce denyRead when sandbox is active
	const localRead = createReadTool(localCwd);
	pi.registerTool({
		...localRead,
		label: "read (sandbox-aware)",
		async execute(id, params, signal, onUpdate, ctx) {
			if (sandboxActive) {
				const cwd = ctx?.cwd ?? localCwd;
				const absolutePath = resolvePathForCheck(params.path, cwd);
				const check = isReadAllowed(absolutePath, cwd);
				if (!check.allowed) {
					throw new Error(
						`Sandbox blocked read of "${params.path}": ${check.reason}.`
					);
				}
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	// Override edit tool — enforce denyRead + allowWrite/denyWrite when sandbox is active
	const localEdit = createEditTool(localCwd);
	pi.registerTool({
		...localEdit,
		label: "edit (sandbox-aware)",
		async execute(id, params, signal, onUpdate, ctx) {
			if (sandboxActive) {
				const cwd = ctx?.cwd ?? localCwd;
				const absolutePath = resolvePathForCheck(params.path, cwd);

				// Edit reads the file first, so check denyRead
				const readCheck = isReadAllowed(absolutePath, cwd);
				if (!readCheck.allowed) {
					throw new Error(
						`Sandbox blocked edit (read) of "${params.path}": ${readCheck.reason}.`
					);
				}

				const writeCheck = isWriteAllowed(absolutePath, cwd);
				if (!writeCheck.allowed) {
					throw new Error(
						`Sandbox blocked edit to "${params.path}": ${writeCheck.reason}. Use /sandbox-add <path> to allow.`
					);
				}
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	// Override write tool — enforce allowWrite/denyWrite when sandbox is active
	const localWrite = createWriteTool(localCwd);
	pi.registerTool({
		...localWrite,
		label: "write (sandbox-aware)",
		async execute(id, params, signal, onUpdate, ctx) {
			if (sandboxActive) {
				const cwd = ctx?.cwd ?? localCwd;
				const absolutePath = resolvePathForCheck(params.path, cwd);
				const check = isWriteAllowed(absolutePath, cwd);
				if (!check.allowed) {
					throw new Error(
						`Sandbox blocked write to "${params.path}": ${check.reason}. Use /sandbox-add <path> to allow.`
					);
				}
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	// Hook user-typed bash commands too
	pi.on("user_bash", () => {
		if (!sandboxActive) return;
		return { operations: createSandboxedBashOps() };
	});

	// ========================================================================
	// Auto-start on session start
	// ========================================================================

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (pi.getFlag("no-sandbox") as boolean) {
			ctx.ui.notify("Sandbox suppressed via --no-sandbox", "info");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			// No config or explicitly disabled — stay quiet
			return;
		}

		enableSandbox(config.filesystem, ctx);
	});

	// ========================================================================
	// Cleanup on shutdown
	// ========================================================================

	pi.on("session_shutdown", async () => {
		if (sandboxActive) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
			sandboxActive = false;
		}
	});

	// ========================================================================
	// Commands
	// ========================================================================

	// /sandbox — show status and config
	pi.registerCommand("sandbox", {
		description: "Show sandbox status and configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatConfig(), "info");
		},
	});

	// /sandbox-on — enable mid-session
	pi.registerCommand("sandbox-on", {
		description: "Enable filesystem sandbox (loads config or uses defaults)",
		handler: async (_args, ctx) => {
			if (sandboxActive) {
				ctx.ui.notify("Sandbox is already active", "info");
				return;
			}

			const config = loadConfig(ctx.cwd);
			enableSandbox(config.filesystem, ctx);
		},
	});

	// /sandbox-off — disable mid-session
	pi.registerCommand("sandbox-off", {
		description: "Disable filesystem sandbox",
		handler: async (_args, ctx) => {
			if (!sandboxActive) {
				ctx.ui.notify("Sandbox is already disabled", "info");
				return;
			}

			sandboxActive = false;
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore
			}
			updateStatus(ctx);
			ctx.ui.notify("Sandbox disabled", "warning");
		},
	});

	// Shared logic for adding a writable path
	function addWritablePath(pathToAdd: string, ctx?: { ui: { setStatus: (id: string, text: string) => void; notify: (msg: string, type?: string) => void; theme: any } }): boolean {
		if (!sandboxActive) return false;
		if (currentFilesystem.allowWrite.includes(pathToAdd)) return true; // already present
		currentFilesystem.allowWrite.push(pathToAdd);
		if (ctx) updateStatus(ctx);
		return true;
	}

	// /sandbox-add <path> — add a writable path on the fly
	pi.registerCommand("sandbox-add", {
		description: "Add a writable path to the sandbox (e.g. /sandbox-add ~/projects/shared)",
		handler: async (args, ctx) => {
			const pathArg = args?.trim();
			if (!pathArg) {
				ctx.ui.notify("Usage: /sandbox-add <path>", "error");
				return;
			}

			if (!sandboxActive) {
				ctx.ui.notify("Sandbox is not active. Use /sandbox-on first.", "error");
				return;
			}

			if (currentFilesystem.allowWrite.includes(pathArg)) {
				ctx.ui.notify(`Path already in allowWrite: ${pathArg}`, "info");
				return;
			}

			currentFilesystem.allowWrite.push(pathArg);
			updateStatus(ctx);
			ctx.ui.notify(`Added writable path: ${pathArg}`, "success");
		},
	});

	// Listen for sandbox:add-path events from other extensions (e.g., finalize)
	pi.events.on("sandbox:add-path", (data) => {
		const { path, result } = data as { path: string; result?: { handled: boolean } };
		const added = addWritablePath(path, currentCtx);
		if (result) {
			result.handled = true; // signal back that sandbox extension is loaded
		}
		if (added && currentCtx) {
			currentCtx.ui.notify(`Sandbox: added writable path '${path}' (via event)`, "info");
		}
	});

	// Listen for sandbox:deny-path events from other extensions (e.g., workflow)
	pi.events.on("sandbox:deny-path", (data) => {
		const { path } = data as { path: string };
		if (!sandboxActive) return;
		if (!currentFilesystem.denyWrite.includes(path)) {
			currentFilesystem.denyWrite.push(path);
			if (currentCtx) {
				updateStatus(currentCtx);
				currentCtx.ui.notify(`Sandbox: denied writable path '${path}' (via event)`, "info");
			}
		}
	});

	// /sandbox-deny <path> — deny writes to a path on the fly
	pi.registerCommand("sandbox-deny", {
		description: "Deny writes to a path (e.g. /sandbox-deny secrets/)",
		handler: async (args, ctx) => {
			const pathArg = args?.trim();
			if (!pathArg) {
				ctx.ui.notify("Usage: /sandbox-deny <path>", "error");
				return;
			}

			if (!sandboxActive) {
				ctx.ui.notify("Sandbox is not active. Use /sandbox-on first.", "error");
				return;
			}

			if (currentFilesystem.denyWrite.includes(pathArg)) {
				ctx.ui.notify(`Path already in denyWrite: ${pathArg}`, "info");
				return;
			}

			currentFilesystem.denyWrite.push(pathArg);
			updateStatus(ctx);
			ctx.ui.notify(`Added write-denied path: ${pathArg}`, "success");
		},
	});
}
