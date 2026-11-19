/**
 * Git Worktree Extension for pi
 *
 * Create, list, and remove git worktrees without leaving pi.
 *
 * Commands:
 *   /wt <branch> [base]   — Create a new worktree + branch
 *   /wt-list               — List all worktrees
 *   /wt-remove <branch>    — Remove a worktree
 *
 * Worktree location:
 *   Worktrees are created at <repo>/.worktrees/<branch>/ inside the
 *   main repository root. .worktrees is auto-added to .gitignore.
 *
 * Limitation:
 *   pi captures its working directory at session start and does not
 *   update it on reload (AgentSession._cwd is set once in the
 *   constructor). This means we cannot switch the AI's working
 *   directory to a worktree mid-session. Worktrees are still useful
 *   for isolating changes — just start a new pi session from the
 *   worktree directory, or use `cd <worktree> &&` prefixes.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

function git(args: string, cwd?: string): string {
	try {
		return execSync(`git ${args}`, {
			cwd: cwd ?? process.cwd(),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch (e: any) {
		throw new Error(e.stderr?.trim() || e.message);
	}
}

/**
 * Get the main repository root. For worktrees, this returns the main
 * working tree path (not the worktree path).
 */
function getMainRepoRoot(cwd?: string): string {
	const commonDir = git("rev-parse --git-common-dir", cwd);
	const resolved = resolve(cwd ?? process.cwd(), commonDir);
	return dirname(resolved);
}

interface WorktreeInfo {
	path: string;
	branch: string;
	commit: string;
	isMain: boolean;
	isCurrent: boolean;
}

function listWorktrees(cwd?: string): WorktreeInfo[] {
	const raw = git("worktree list --porcelain", cwd);
	if (!raw) return [];

	const currentPath = resolve(cwd ?? process.cwd());
	const worktrees: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> = {};

	for (const line of raw.split("\n")) {
		if (line.startsWith("worktree ")) {
			current.path = line.slice("worktree ".length);
		} else if (line.startsWith("HEAD ")) {
			current.commit = line.slice("HEAD ".length).slice(0, 8);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).replace("refs/heads/", "");
		} else if (line === "bare") {
			current.branch = "(bare)";
		} else if (line === "detached") {
			current.branch = "(detached)";
		} else if (line === "") {
			if (current.path) {
				const resolvedPath = resolve(current.path);
				worktrees.push({
					path: resolvedPath,
					branch: current.branch || "(unknown)",
					commit: current.commit || "",
					isMain: worktrees.length === 0,
					isCurrent: resolvedPath === currentPath,
				});
			}
			current = {};
		}
	}
	// Handle last entry (if no trailing newline)
	if (current.path) {
		const resolvedPath = resolve(current.path);
		worktrees.push({
			path: resolvedPath,
			branch: current.branch || "(unknown)",
			commit: current.commit || "",
			isMain: worktrees.length === 0,
			isCurrent: resolvedPath === currentPath,
		});
	}

	return worktrees;
}

/**
 * Get the worktrees directory path for a given repo.
 * Uses .worktrees/ inside the repo root. Ensures it's in .gitignore.
 */
function getWorktreesDir(mainRepo: string): string {
	const wtDir = join(mainRepo, ".worktrees");
	ensureGitignored(mainRepo, ".worktrees");
	return wtDir;
}

/**
 * Ensure a pattern is in .gitignore. Adds it if missing.
 */
function ensureGitignored(repoRoot: string, pattern: string): void {
	const gitignorePath = join(repoRoot, ".gitignore");
	try {
		let content = "";
		if (existsSync(gitignorePath)) {
			content = readFileSync(gitignorePath, "utf-8");
		}
		// Check if already present (exact line match)
		const lines = content.split("\n");
		if (lines.some((line) => line.trim() === pattern)) return;

		// Append it
		const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		writeFileSync(gitignorePath, content + separator + pattern + "\n");
	} catch {}
}

export default function (pi: ExtensionAPI) {
	// ========================================================================
	// AI-callable tool
	// ========================================================================

	pi.registerTool({
		name: "worktree",
		label: "Git Worktree",
		description:
			"Manage git worktrees. Create a new worktree with a branch to work in isolation, " +
			"list existing worktrees, or remove one. " +
			"Worktrees are created at <repo>/.worktrees/<branch-name>/. " +
			"Note: pi's working directory cannot be changed mid-session, so after creating " +
			"a worktree you must start a new pi session from that directory to work in it.",
		parameters: Type.Object({
			action: StringEnum(["create", "list", "remove"] as const, {
				description: "Action to perform",
			}),
			branch: Type.Optional(
				Type.String({
					description:
						"Branch name (required for create/remove). " +
						"For create, this becomes the new branch name.",
				}),
			),
			base: Type.Optional(
				Type.String({
					description:
						"Base ref for create (e.g. 'main', 'HEAD'). Defaults to current HEAD.",
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { action, branch, base } = params;

			try {
				switch (action) {
					case "create": {
						if (!branch) {
							return {
								content: [{ type: "text", text: "Error: branch name is required for create" }],
								isError: true,
							};
						}

						const mainRepo = getMainRepoRoot();
						const wtDir = getWorktreesDir(mainRepo);
						const dirName = branch.replace(/\//g, "-");
						const wtPath = join(wtDir, dirName);

						if (existsSync(wtPath)) {
							return {
								content: [{
									type: "text",
									text: `Worktree already exists at ${wtPath}.`,
								}],
								isError: true,
							};
						}

						mkdirSync(wtDir, { recursive: true });
						const baseArg = base ? ` ${base}` : "";
						git(`worktree add -b ${branch} "${wtPath}"${baseArg}`, mainRepo);

						return {
							content: [{
								type: "text",
								text: `Created worktree at ${wtPath} on branch '${branch}'. ` +
									`To work in it, start a new pi session from that directory.`,
							}],
						};
					}

					case "list": {
						const worktrees = listWorktrees();
						if (worktrees.length === 0) {
							return {
								content: [{ type: "text", text: "No worktrees found." }],
							};
						}

						const lines = worktrees.map((wt) => {
							const marker = wt.isCurrent ? " ← current" : "";
							const tag = wt.isMain ? " (main)" : "";
							return `${wt.branch}${tag}${marker}\n  ${wt.path} [${wt.commit}]`;
						});

						return {
							content: [{ type: "text", text: lines.join("\n") }],
						};
					}

					case "remove": {
						if (!branch) {
							return {
								content: [{ type: "text", text: "Error: branch name is required for remove" }],
								isError: true,
							};
						}

						const allWt = listWorktrees();
						const rmTarget = allWt.find(
							(wt) => wt.branch === branch || wt.branch.endsWith(`/${branch}`),
						);

						if (!rmTarget) {
							return {
								content: [{ type: "text", text: `No worktree found for branch '${branch}'.` }],
								isError: true,
							};
						}

						if (rmTarget.isMain) {
							return {
								content: [{ type: "text", text: "Cannot remove the main working tree." }],
								isError: true,
							};
						}

						if (rmTarget.isCurrent) {
							return {
								content: [{
									type: "text",
									text: "Cannot remove the current worktree. Run pi from a different directory first.",
								}],
								isError: true,
							};
						}

						git(`worktree remove "${rmTarget.path}" --force`);

						return {
							content: [{
								type: "text",
								text: `Removed worktree for branch '${rmTarget.branch}' at ${rmTarget.path}. ` +
									`Local branch kept (delete manually with 'git branch -D ${rmTarget.branch}' if desired).`,
							}],
						};
					}
				}
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message}` }],
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				isError: true,
			};
		},
	});

	// ========================================================================
	// User commands
	// ========================================================================

	// /wt <branch> [base] — create a new worktree
	pi.registerCommand("wt", {
		description: "Create a new git worktree. Usage: /wt <branch> [base-ref]",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) || [];
			const branch = parts[0];
			const base = parts[1];

			if (!branch) {
				ctx.ui.notify(
					"Usage: /wt <branch> [base-ref]\nExample: /wt feature/auth main",
					"error",
				);
				return;
			}

			try {
				const mainRepo = getMainRepoRoot();
				const wtDir = getWorktreesDir(mainRepo);
				const dirName = branch.replace(/\//g, "-");
				const wtPath = join(wtDir, dirName);

				if (existsSync(wtPath)) {
					ctx.ui.notify(
						`Worktree path already exists: ${wtPath}`,
						"error",
					);
					return;
				}

				mkdirSync(wtDir, { recursive: true });

				const baseArg = base ? ` ${base}` : "";
				git(`worktree add -b ${branch} "${wtPath}"${baseArg}`, mainRepo);

				ctx.ui.notify(
					`Created worktree: ${wtPath}\nBranch: ${branch}\n\n` +
						`To work in it, start a new pi session:\n  cd ${wtPath} && pi`,
					"info",
				);
			} catch (e: any) {
				ctx.ui.notify(`Failed to create worktree: ${e.message}`, "error");
			}
		},
	});

	// /wt-list — list all worktrees
	pi.registerCommand("wt-list", {
		description: "List all git worktrees",
		handler: async (_args, ctx) => {
			try {
				const worktrees = listWorktrees();
				if (worktrees.length === 0) {
					ctx.ui.notify("No worktrees found (not a git repo?)", "warning");
					return;
				}

				const lines = ["Git Worktrees:", ""];
				for (const wt of worktrees) {
					const marker = wt.isCurrent ? " ← current" : "";
					const tag = wt.isMain ? " (main)" : "";
					lines.push(`  ${wt.branch}${tag}${marker}`);
					lines.push(`    ${wt.path} [${wt.commit}]`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e: any) {
				ctx.ui.notify(`Failed to list worktrees: ${e.message}`, "error");
			}
		},
	});

	// /wt-remove <branch> — remove a worktree
	pi.registerCommand("wt-remove", {
		description: "Remove a git worktree. Usage: /wt-remove <branch>",
		handler: async (args, ctx) => {
			const branch = args?.trim();
			if (!branch) {
				ctx.ui.notify("Usage: /wt-remove <branch>", "error");
				return;
			}

			try {
				const worktrees = listWorktrees();
				const target = worktrees.find(
					(wt) => wt.branch === branch || wt.branch.endsWith(`/${branch}`),
				);

				if (!target) {
					ctx.ui.notify(`No worktree found for branch: ${branch}`, "error");
					return;
				}

				if (target.isMain) {
					ctx.ui.notify("Cannot remove the main working tree", "error");
					return;
				}

				if (target.isCurrent) {
					ctx.ui.notify(
						"Cannot remove the current worktree. Run pi from a different directory first.",
						"error",
					);
					return;
				}

				const confirmed = await ctx.ui.confirm(
					"Remove Worktree",
					`Remove worktree for branch '${target.branch}'?\nPath: ${target.path}`,
				);

				if (!confirmed) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}

				git(`worktree remove "${target.path}" --force`);

				const deleteBranch = await ctx.ui.confirm(
					"Delete Branch",
					`Also delete the local branch '${target.branch}'?`,
				);

				if (deleteBranch) {
					try {
						git(`branch -D ${target.branch}`);
						ctx.ui.notify(
							`Removed worktree and deleted branch: ${target.branch}`,
							"success",
						);
					} catch (e: any) {
						ctx.ui.notify(
							`Worktree removed. Branch delete failed: ${e.message}`,
							"warning",
						);
					}
				} else {
					ctx.ui.notify(
						`Removed worktree: ${target.branch} (branch kept)`,
						"success",
					);
				}
			} catch (e: any) {
				ctx.ui.notify(`Failed to remove worktree: ${e.message}`, "error");
			}
		},
	});
}
