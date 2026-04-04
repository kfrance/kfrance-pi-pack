/**
 * Command Gate Extension
 *
 * Requires user confirmation before executing:
 * - gh API commands that modify GitHub (POST, PUT, PATCH, DELETE)
 * - gh CLI commands that modify GitHub (pr create/merge/comment, issue create, etc.)
 * - Destructive or state-changing git commands (add, commit, push, rebase, reset, etc.)
 * - Any use of gog
 *
 * Read-only git/GitHub commands (gh api GET, git status, git log, git diff, etc.)
 * still pass through freely. gog is always gated.
 *
 * Also logs every bash command it sees to JSONL in:
 *   $XDG_STATE_HOME/kfrance-pi-pack/command-gate
 * or:
 *   ~/.local/state/kfrance-pi-pack/command-gate
 *
 * The active log file is command-gate.jsonl and it rotates at 50 MiB with
 * unlimited numbered archives (command-gate.jsonl.1, .2, ...).
 */

import { appendFile, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const DEFAULT_LOG_FILE_NAME = "command-gate.jsonl";
export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_LOG_LOCK_FILE_NAME = ".command-gate.lock";
export const DEFAULT_LOG_LOCK_RETRY_MS = 25;
export const DEFAULT_LOG_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_LOG_LOCK_STALE_MS = 30000;

export type CommandDecision = "allowed" | "confirmed" | "blocked";

export interface CommandGateLogEntry {
	timestamp: string;
	toolName: "bash";
	pid: number;
	command: string;
	matched: boolean;
	matchReason?: string;
	decision: CommandDecision;
	decisionReason: string;
	hasUI: boolean;
}

export interface AppendCommandGateLogOptions {
	logDir?: string;
	maxBytes?: number;
}

export interface GatedPattern {
	reason: string;
	pattern: RegExp;
	matches?: (command: string) => boolean;
}

export interface LogLockOptions {
	retryMs?: number;
	timeoutMs?: number;
	staleMs?: number;
}

// Matches zero or more git global options between "git" and the subcommand.
// Handles: -c key=val, -c key="val with spaces", -c key="val with $(cmd)",
// -C path, --no-pager, --git-dir=x, --work-tree=x, etc.
// This prevents bypasses like: git -c "http...." push
//
// Flag value matching (in order of priority):
//   "..."     double-quoted (non-greedy, handles nested $() and spaces)
//   '...'     single-quoted (no interpolation)
//   \S+=".."  unquoted key with quoted value (e.g. credential.helper="!cmd")
//   \S+='...' unquoted key with single-quoted value
//   \S+       plain unquoted value
const GIT_OPTS = String.raw`(?:(?:-[pP]\s+|-[a-zA-Z]\s+(?:".*?"|'[^']*'|\S+(?:=".*?"|='[^']*')?)\s+|--[\w-]+(?:[=\s](?:".*?"|'[^']*'|\S+(?:=".*?"|='[^']*')?))?(?:\s+|(?=\s)))*)`;
const GH_API_METHOD_FLAG = String.raw`(?:-X(?:\s*|=)|--method(?:\s+|=))`;
const GH_API_WRITE_METHOD = new RegExp(String.raw`(?:^|\s)${GH_API_METHOD_FLAG}(POST|PUT|PATCH|DELETE)\b`, "i");
const GH_API_READ_METHOD = new RegExp(String.raw`(?:^|\s)${GH_API_METHOD_FLAG}GET\b`, "i");
const GH_API_FIELD_FLAG = /(?:^|\s)(?:-f|--raw-field|-F|--field|--input)\b/i;
const SHELL_SEGMENT_SPLIT = /&&|\|\||\||;|\n/;

function gitCmd(subcmd: string): RegExp {
	return new RegExp(String.raw`\bgit\s+${GIT_OPTS}${subcmd}\b`, "i");
}

export const gatedPatterns: GatedPattern[] = [
	// Any gog usage
	{ reason: "gog usage", pattern: /\bgog\b/i },

	// gh API write methods
	{ reason: "gh api write method", pattern: /\bgh\s+api\b/i, matches: hasGhApiWriteMethod },
	{ reason: "gh api implicit POST via fields/input", pattern: /\bgh\s+api\b/i, matches: hasGhApiImplicitWrite },

	// gh CLI write commands
	{ reason: "gh pr write command", pattern: /\bgh\s+pr\s+(create|merge|close|edit|comment|review)\b/i },
	{ reason: "gh issue write command", pattern: /\bgh\s+issue\s+(create|close|edit|comment|delete|transfer)\b/i },
	{ reason: "gh release write command", pattern: /\bgh\s+release\s+(create|delete|edit)\b/i },

	// git state-changing commands (allows global options between git and subcommand)
	{ reason: "git add", pattern: gitCmd("add") },
	{ reason: "git commit", pattern: gitCmd("commit") },
	{ reason: "git push", pattern: gitCmd("push") },
	{ reason: "git rebase", pattern: gitCmd("rebase") },
	{ reason: "git reset", pattern: gitCmd("reset") },
	{ reason: "git merge", pattern: gitCmd("merge(?!-(base|tree)\\b)") }, // "merge" but not read-only "merge-base", "merge-tree"
	{ reason: "git cherry-pick", pattern: gitCmd("cherry-pick") },
	{ reason: "git revert", pattern: gitCmd("revert") },
	{ reason: "git stash", pattern: gitCmd("stash") },
	{ reason: "git clean", pattern: gitCmd("clean") },
	{ reason: "git restore", pattern: gitCmd("restore") },
	{ reason: "git checkout --", pattern: gitCmd("checkout\\b.*\\s--\\s") }, // checkout with -- (file restore)
	{ reason: "git branch delete", pattern: gitCmd("branch\\s+(?:-[dD]|--delete)") },
	{ reason: "git tag delete", pattern: gitCmd("tag\\s+(?:-d|--delete)") },
	{ reason: "git push --force", pattern: gitCmd("push\\b.*--force") },
	{ reason: "git push -f", pattern: gitCmd("push\\b.*\\s-f") },
];

function getShellSegments(command: string): string[] {
	return command
		.split(SHELL_SEGMENT_SPLIT)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function hasGhApiWriteMethod(command: string): boolean {
	return getShellSegments(command).some((segment) => /\bgh\s+api\b/i.test(segment) && GH_API_WRITE_METHOD.test(segment));
}

function hasGhApiImplicitWrite(command: string): boolean {
	return getShellSegments(command).some(
		(segment) => /\bgh\s+api\b/i.test(segment) && GH_API_FIELD_FLAG.test(segment) && !GH_API_READ_METHOD.test(segment),
	);
}

export function matchGatedCommand(command: string): string | undefined {
	return gatedPatterns.find(({ pattern, matches }) => matches ? matches(command) : pattern.test(command))?.reason;
}

export function isGatedCommand(command: string): boolean {
	return matchGatedCommand(command) !== undefined;
}

export function resolveLogDirectory(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
	const xdgStateHome = env.XDG_STATE_HOME?.trim();
	const baseDir = xdgStateHome || path.join(homeDir, ".local", "state");
	return path.join(baseDir, "kfrance-pi-pack", "command-gate");
}

export function getActiveLogPath(logDir = resolveLogDirectory()): string {
	return path.join(logDir, DEFAULT_LOG_FILE_NAME);
}

export function getLogLockPath(logDir = resolveLogDirectory()): string {
	return path.join(logDir, DEFAULT_LOG_LOCK_FILE_NAME);
}

export async function getNextRotatedLogPath(logDir: string, fileName = DEFAULT_LOG_FILE_NAME): Promise<string> {
	const prefix = `${fileName}.`;
	let maxSuffix = 0;

	try {
		for (const entry of await readdir(logDir)) {
			if (!entry.startsWith(prefix)) continue;

			const suffix = entry.slice(prefix.length);
			if (!/^\d+$/.test(suffix)) continue;

			maxSuffix = Math.max(maxSuffix, Number(suffix));
		}
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}

	return path.join(logDir, `${fileName}.${maxSuffix + 1}`);
}

export async function rotateLogIfNeeded(
	activeLogPath: string,
	incomingBytes: number,
	maxBytes = DEFAULT_LOG_MAX_BYTES,
): Promise<string | undefined> {
	try {
		const currentSize = (await stat(activeLogPath)).size;
		if (currentSize + incomingBytes <= maxBytes) return undefined;
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}

	const rotatedLogPath = await getNextRotatedLogPath(path.dirname(activeLogPath), path.basename(activeLogPath));
	await rename(activeLogPath, rotatedLogPath);
	return rotatedLogPath;
}

export async function withLogLock<T>(logDir: string, fn: () => Promise<T>, options: LogLockOptions = {}): Promise<T> {
	const retryMs = options.retryMs ?? DEFAULT_LOG_LOCK_RETRY_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOG_LOCK_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_LOG_LOCK_STALE_MS;
	const lockPath = getLogLockPath(logDir);
	const startedAt = Date.now();

	while (true) {
		try {
			const lockHandle = await open(lockPath, "wx");

			try {
				return await fn();
			} finally {
				await lockHandle.close();
				await unlink(lockPath).catch((error) => {
					if (!isMissingFileError(error)) throw error;
				});
			}
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
			if (await isStaleLock(lockPath, staleMs)) {
				await unlink(lockPath).catch((unlinkError) => {
					if (!isMissingFileError(unlinkError)) throw unlinkError;
				});
				continue;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out waiting for command-gate log lock after ${timeoutMs}ms`);
			}
			await delay(retryMs);
		}
	}
}

export async function appendCommandGateLog(
	entry: CommandGateLogEntry,
	options: AppendCommandGateLogOptions = {},
): Promise<string> {
	const logDir = options.logDir ?? resolveLogDirectory();
	const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
	const activeLogPath = getActiveLogPath(logDir);
	const line = `${JSON.stringify(entry)}\n`;

	await mkdir(logDir, { recursive: true });

	return withLogLock(logDir, async () => {
		const rotatedLogPath = await rotateLogIfNeeded(activeLogPath, Buffer.byteLength(line), maxBytes);

		try {
			await appendFile(activeLogPath, line, "utf8");
		} catch (error) {
			if (rotatedLogPath) {
				await restoreRotatedLogOnAppendFailure(rotatedLogPath, activeLogPath);
			}
			throw error;
		}

		return activeLogPath;
	});
}

async function restoreRotatedLogOnAppendFailure(rotatedLogPath: string, activeLogPath: string): Promise<void> {
	try {
		await stat(activeLogPath);
		return;
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}

	try {
		await rename(rotatedLogPath, activeLogPath);
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
	try {
		const lockStats = await stat(lockPath);
		return Date.now() - lockStats.mtimeMs >= staleMs;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createLogEntry(
	command: string,
	hasUI: boolean,
	decision: CommandDecision,
	decisionReason: string,
	matchReason?: string,
): CommandGateLogEntry {
	return {
		timestamp: new Date().toISOString(),
		toolName: "bash",
		pid: process.pid,
		command,
		matched: matchReason !== undefined,
		matchReason,
		decision,
		decisionReason,
		hasUI,
	};
}

export default function (pi: ExtensionAPI) {
	let logQueue = Promise.resolve();

	async function logCommand(entry: CommandGateLogEntry): Promise<void> {
		logQueue = logQueue.catch(() => undefined).then(() => appendCommandGateLog(entry));

		try {
			await logQueue;
		} catch (error) {
			console.warn(`[command-gate] Failed to write command log: ${formatErrorMessage(error)}`);
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const matchReason = matchGatedCommand(command);

		if (!matchReason) {
			await logCommand(createLogEntry(command, ctx.hasUI, "allowed", "no pattern matched"));
			return undefined;
		}

		if (!ctx.hasUI) {
			await logCommand(createLogEntry(command, ctx.hasUI, "blocked", "no UI available for confirmation", matchReason));
			return { block: true, reason: "Gated command blocked (no UI for confirmation)" };
		}

		const choice = await ctx.ui.select(`⚠️ Gated command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

		if (choice !== "Yes") {
			await logCommand(createLogEntry(command, ctx.hasUI, "blocked", "blocked by user", matchReason));
			return { block: true, reason: "Blocked by user" };
		}

		await logCommand(createLogEntry(command, ctx.hasUI, "confirmed", "confirmed by user", matchReason));
		return undefined;
	});
}
