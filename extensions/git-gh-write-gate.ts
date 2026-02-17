/**
 * Git & GitHub Write Gate Extension
 *
 * Requires user confirmation before executing:
 * - gh API commands that modify GitHub (POST, PUT, PATCH, DELETE)
 * - gh CLI commands that modify GitHub (pr create/merge/comment, issue create, etc.)
 * - Destructive or state-changing git commands (add, commit, push, rebase, reset, etc.)
 *
 * Read-only commands (gh api GET, git status, git log, git diff, etc.) pass through freely.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
const GIT_OPTS = String.raw`(?:(?:-[a-zA-Z]\s+(?:".*?"|'[^']*'|\S+(?:=".*?"|='[^']*')?)\s+|--[\w-]+(?:[=\s](?:".*?"|'[^']*'|\S+(?:=".*?"|='[^']*')?))?(?:\s+|(?=\s)))*)`;

function gitCmd(subcmd: string): RegExp {
	return new RegExp(String.raw`\bgit\s+${GIT_OPTS}${subcmd}\b`, "i");
}

export const writePatterns: RegExp[] = [
	// gh API write methods
	/\bgh\s+api\b.*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i,
	/\bgh\s+api\b.*\s--method\s+(POST|PUT|PATCH|DELETE)\b/i,

	// gh CLI write commands
	/\bgh\s+pr\s+(create|merge|close|edit|comment|review)\b/i,
	/\bgh\s+issue\s+(create|close|edit|comment|delete|transfer)\b/i,
	/\bgh\s+release\s+(create|delete|edit)\b/i,

	// git state-changing commands (allows global options between git and subcommand)
	gitCmd("add"),
	gitCmd("commit"),
	gitCmd("push"),
	gitCmd("rebase"),
	gitCmd("reset"),
	gitCmd("merge"),
	gitCmd("cherry-pick"),
	gitCmd("revert"),
	gitCmd("stash"),
	gitCmd("clean"),
	gitCmd("restore"),
	gitCmd("checkout\\b.*\\s--\\s"), // checkout with -- (file restore)
	gitCmd("branch\\s+-[dD]"), // branch deletion
	gitCmd("tag\\s+-d"), // tag deletion
	gitCmd("push\\b.*--force"), // force push (long flag)
	gitCmd("push\\b.*\\s-f"), // force push (short flag)
];

export function isWriteCommand(command: string): boolean {
	return writePatterns.some((p) => p.test(command));
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		if (isWriteCommand(command)) {
			if (!ctx.hasUI) {
				return { block: true, reason: "Git/GitHub write command blocked (no UI for confirmation)" };
			}

			const choice = await ctx.ui.select(`✍️ Git/GitHub write command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
