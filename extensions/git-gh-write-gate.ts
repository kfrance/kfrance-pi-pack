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

export const writePatterns: RegExp[] = [
	// gh API write methods
	/\bgh\s+api\b.*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i,
	/\bgh\s+api\b.*\s--method\s+(POST|PUT|PATCH|DELETE)\b/i,

	// gh CLI write commands
	/\bgh\s+pr\s+(create|merge|close|edit|comment|review)\b/i,
	/\bgh\s+issue\s+(create|close|edit|comment|delete|transfer)\b/i,
	/\bgh\s+release\s+(create|delete|edit)\b/i,

	// git state-changing commands
	/\bgit\s+add\b/i,
	/\bgit\s+commit\b/i,
	/\bgit\s+push\b/i,
	/\bgit\s+rebase\b/i,
	/\bgit\s+reset\b/i,
	/\bgit\s+merge\b/i,
	/\bgit\s+cherry-pick\b/i,
	/\bgit\s+revert\b/i,
	/\bgit\s+stash\b/i,
	/\bgit\s+clean\b/i,
	/\bgit\s+checkout\b.*\s--\s/i, // checkout with -- (file restore)
	/\bgit\s+restore\b/i,
	/\bgit\s+branch\s+-[dD]\b/i, // branch deletion
	/\bgit\s+tag\s+-d\b/i, // tag deletion
	/\bgit\s+push\b.*--force/i,
	/\bgit\s+push\b.*\s-f\b/i,
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
