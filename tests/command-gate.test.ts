import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import commandGateExtension, {
	appendCommandGateLog,
	getActiveLogPath,
	getLogLockPath,
	getNextRotatedLogPath,
	isGatedCommand,
	resolveLogDirectory,
} from "../extensions/command-gate.ts";

// Each entry: [command, shouldBlock, description]
type TestCase = [string, boolean, string];

function runCases(cases: TestCase[]) {
	for (const [command, shouldBlock, description] of cases) {
		it(description, () => {
			assert.strictEqual(isGatedCommand(command), shouldBlock, `Command: ${command}`);
		});
	}
}

describe("command-gate", () => {
	describe("gog commands", () => {
		runCases([
			["gog send --to test@example.com --subject 'hi' --body 'hello'", true, "blocks gog send"],
			["gog -n send --to test@example.com --subject 'hi' --body 'hello'", true, "blocks gog even in dry-run mode"],
			["echo 'run gog send later'", true, "blocks mentions of gog for safety"],
			["google-chrome --app=http://localhost:3000", false, "does not block unrelated commands containing gog substring"],
		]);
	});

	describe("gh API write methods", () => {
		runCases([
			["gh api repos/owner/repo/pulls/1/comments -X POST -f body='hi'", true, "blocks gh api -X POST"],
			["gh api repos/owner/repo/issues/1 -X DELETE", true, "blocks gh api -X DELETE"],
			["gh api repos/owner/repo/pulls/1 -X PATCH -f title='new'", true, "blocks gh api -X PATCH"],
			["gh api repos/owner/repo/pulls/1/merge -X PUT", true, "blocks gh api -X PUT"],
			["gh api repos/owner/repo/comments --method POST -f body='hi'", true, "blocks gh api --method POST"],
			["gh api repos/owner/repo/comments --method=POST -f body='hi'", true, "blocks gh api --method=POST"],
			["gh api repos/owner/repo/comments -XPOST -f body='hi'", true, "blocks gh api -XPOST"],
			["gh api repos/owner/repo/issues -f title='bug'", true, "blocks gh api implicit POST via -f"],
			["gh api repos/owner/repo/issues --raw-field title='bug'", true, "blocks gh api implicit POST via --raw-field"],
			["gh api repos/owner/repo/issues -F title='bug'", true, "blocks gh api implicit POST via -F"],
			["gh api repos/owner/repo/issues --field title='bug'", true, "blocks gh api implicit POST via --field"],
			["gh api repos/owner/repo/issues --input payload.json", true, "blocks gh api implicit POST via --input"],
			["gh api repos/owner/repo/pulls/302", false, "allows gh api GET (default)"],
			["gh api repos/owner/repo/pulls/302/comments --jq '.[]'", false, "allows gh api with --jq"],
			["gh api repos/owner/repo/issues --method GET -f state=open", false, "allows gh api explicit GET with fields"],
			["gh api repos/owner/repo/issues --method=GET -f state=open", false, "allows gh api explicit GET with equals syntax"],
			["gh api repos/owner/repo/issues -XGET -f state=open", false, "allows gh api explicit GET with compact short flag"],
			[
				"gh api repos/owner/repo/issues -f title='bug' && gh api repos/owner/repo/issues --method GET",
				true,
				"blocks gh api implicit POST even when a later command uses explicit GET",
			],
		]);
	});

	describe("gh CLI write commands", () => {
		runCases([
			["gh pr create --title 'test' --body 'test'", true, "blocks gh pr create"],
			["gh pr merge 302 --squash", true, "blocks gh pr merge"],
			["gh pr comment 302 --body 'looks good'", true, "blocks gh pr comment"],
			["gh pr close 302", true, "blocks gh pr close"],
			["gh pr review 302 --approve", true, "blocks gh pr review"],
			["gh pr edit 302 --title 'new title'", true, "blocks gh pr edit"],
			["gh issue create --title 'bug'", true, "blocks gh issue create"],
			["gh issue comment 42 --body 'fixed'", true, "blocks gh issue comment"],
			["gh issue close 42", true, "blocks gh issue close"],
			["gh issue delete 42", true, "blocks gh issue delete"],
			["gh issue transfer 42 other-repo", true, "blocks gh issue transfer"],
			["gh release create v1.0.0", true, "blocks gh release create"],
			["gh release delete v1.0.0", true, "blocks gh release delete"],
			["gh release edit v1.0.0 --draft", true, "blocks gh release edit"],
			["gh pr view 302", false, "allows gh pr view"],
			["gh pr list --state open", false, "allows gh pr list"],
			["gh issue list", false, "allows gh issue list"],
			["gh pr view 302 --json title,body", false, "allows gh pr view with json"],
		]);
	});

	describe("git simple commands", () => {
		runCases([
			["git add .", true, "blocks git add"],
			["git add src/main.ts", true, "blocks git add with path"],
			['git commit -m "fix bug"', true, "blocks git commit"],
			["git push origin main", true, "blocks git push"],
			["git push --force origin main", true, "blocks git push --force"],
			["git push -f origin main", true, "blocks git push -f"],
			["git rebase main", true, "blocks git rebase"],
			["git rebase -i HEAD~3", true, "blocks git rebase interactive"],
			["git reset --hard HEAD~1", true, "blocks git reset hard"],
			["git reset --soft HEAD~1", true, "blocks git reset soft"],
			["git merge feature-branch", true, "blocks git merge"],
			["git merge-base main feature-branch", false, "allows git merge-base (read-only)"],
			["git merge-tree HEAD main feature", false, "allows git merge-tree (read-only)"],
			["git merge-file a.txt base.txt b.txt", true, "blocks git merge-file (writes)"],
			["git merge-index git-merge-one-file -a", true, "blocks git merge-index (writes)"],
			["git cherry-pick abc123", true, "blocks git cherry-pick"],
			["git revert HEAD", true, "blocks git revert"],
			["git stash", true, "blocks git stash"],
			["git stash pop", true, "blocks git stash pop"],
			["git clean -fd", true, "blocks git clean"],
			["git restore src/main.ts", true, "blocks git restore"],
			["git checkout -- src/main.ts", true, "blocks git checkout -- (file restore)"],
			["git branch -d old-branch", true, "blocks git branch -d"],
			["git branch -D old-branch", true, "blocks git branch -D"],
			["git branch --delete old-branch", true, "blocks git branch --delete"],
			["git tag -d v1.0.0", true, "blocks git tag -d"],
			["git tag --delete v1.0.0", true, "blocks git tag --delete"],
		]);
	});

	describe("git with global options between git and subcommand", () => {
		runCases([
			['git -c key=val push origin main', true, "blocks git -c key=val push"],
			['git -C /project add .', true, "blocks git -C /project add"],
			['git -P push origin main', true, "blocks git -P push"],
			['git -p commit -m "msg"', true, "blocks git -p commit"],
			['git --no-pager commit -m "msg"', true, "blocks git --no-pager commit"],
			['git --git-dir=.git push origin main', true, "blocks git --git-dir=.git push"],
			['git --work-tree=/project reset --hard HEAD', true, "blocks git --work-tree=... reset"],
			['git -c "http.https://github.com/.extraheader=Authorization: basic stuff" push 2>&1', true, "blocks git -c with quoted value push"],
			["git -c 'user.name=Test' commit -m 'msg'", true, "blocks git -c with single-quoted value commit"],
			['git -C /tmp -c key=val push origin main', true, "blocks git with multiple global options push"],
			['git --no-pager --git-dir=.git add .', true, "blocks git with multiple long options add"],
			['git -P -c key=val push origin main', true, "blocks git with mixed short and value-taking global options push"],
			// Should NOT match subcommand appearing as a flag value
			['git log --format=push', false, "allows git log --format=push (push is a value, not subcommand)"],
			['git config push.default simple', false, "allows git config mentioning push as argument"],
			['git --no-pager log --oneline', false, "allows git --no-pager log (read-only)"],
			['git -C /project status', false, "allows git -C /project status (read-only)"],
			['git --git-dir=.git log --oneline', false, "allows git --git-dir log (read-only)"],
			['git -P status', false, "allows git -P status (read-only)"],
		]);
	});

	describe("compound commands (&&, ||, ;, pipes)", () => {
		runCases([
			["cd /data/project && git add .", true, "blocks git add after &&"],
			['git add . && git commit -m "update"', true, "blocks git commit in && chain"],
			['git add . && git commit -m "update" && git push origin main', true, "blocks git push in && chain"],
			["git merge feature || git reset --hard HEAD", true, "blocks git reset after ||"],
			["echo 'done'; git add .", true, "blocks git add after ;"],
			['ls -la; git commit -m "quick fix"', true, "blocks git commit after ;"],
			["echo 'posting' && gh api repos/owner/repo/comments -X POST -f body='hi'", true, "blocks gh api POST in && chain"],
			["gh api repos/o/r/issues -f title='bug' | jq .", true, "blocks gh api implicit POST before a pipe to jq"],
			["gh api repos/o/r/issues -f title='bug' | gh api repos/o/r/issues --method GET", true, "blocks gh api implicit POST before a later piped GET command"],
			["gh api repos/o/r/issues --method GET -f state=open | gh api repos/o/r/issues -f title='bug'", true, "blocks gh api implicit POST after an earlier piped GET command"],
			["echo 'pushing' | tee log.txt && git push origin main", true, "blocks git push after pipe and &&"],
			["git fetch origin && git rebase origin/main && echo 'done'", true, "blocks git rebase in complex chain"],
			["git fetch origin && git log --oneline -5", false, "allows read-only && chain"],
			["git status; git diff", false, "allows read-only ; chain"],
			["git log --oneline | head -20", false, "allows piped read-only"],
			["git diff HEAD~1 | grep 'TODO'", false, "allows git diff piped to grep"],
		]);
	});

	describe("subshells and command substitution", () => {
		runCases([
			["(cd /project && git add .)", true, "blocks git add inside (...)"],
			['(git add . && git commit -m "msg")', true, "blocks git commit inside (...)"],
			["echo $(git push origin main 2>&1)", true, "blocks git push inside $(...)"],
			["echo `git reset --hard HEAD`", true, "blocks git reset inside backticks"],
			["(gh api repos/o/r/comments -X POST -f body='hi')", true, "blocks gh api POST inside (...)"],
			["echo $(git log --oneline -1)", false, "allows read-only inside $(...)"],
		]);
	});

	describe("multiline commands", () => {
		runCases([
			["cd /project\ngit add .", true, "blocks git add on second line"],
			['cd /project\ngit add .\ngit commit -m "msg"', true, "blocks git commit on third line"],
			["git add .\ngit commit -m 'update'\ngit push origin main", true, "blocks git push in multiline"],
			["BODY='hello'\ngh api repos/o/r/comments -X POST -f body=\"$BODY\"", true, "blocks gh api POST on later line"],
			["git status\ngit log --oneline -5\ngit diff", false, "allows multiline read-only"],
		]);
	});

	describe("environment variables and quoting", () => {
		runCases([
			["GIT_SSH_COMMAND='ssh -i key' git push origin main", true, "blocks git push with env var prefix"],
			['git commit -m "$COMMIT_MSG"', true, "blocks git commit with env var in message"],
			["git add ${FILE_PATH}", true, "blocks git add with variable expansion"],
			[`gh api repos/o/r/comments -X POST -f body="it's done"`, true, "blocks gh api POST with quoted body"],
			["git push origin $BRANCH_NAME", true, "blocks git push with variable branch"],
		]);
	});

	describe("heredocs and redirections", () => {
		runCases([
			['git commit -m "$(cat <<EOF\nLong message\nEOF\n)"', true, "blocks git commit with heredoc"],
			["gh api repos/o/r/comments -X POST -f body='hi' > /dev/null", true, "blocks gh api POST with redirect"],
			["git push origin main 2>&1", true, "blocks git push with stderr redirect"],
			["git stash 2>&1 | tee stash.log", true, "blocks git stash with output redirect"],
		]);
	});

	describe("conditional and loop constructs", () => {
		runCases([
			['if [ -n "$PUSH" ]; then git push origin main; fi', true, "blocks git push inside if"],
			["for f in *.ts; do git add $f; done", true, "blocks git add inside for loop"],
			['while true; do git commit -m "auto"; sleep 60; done', true, "blocks git commit inside while"],
			["if true; then gh api repos/o/r -X POST -f body='y'; fi", true, "blocks gh api POST inside if"],
			["if [ -d .git ]; then git status; fi", false, "allows read-only inside if"],
		]);
	});

	describe("real-world bypass attempts", () => {
		runCases([
			[
				'cd /data/kfrance-pi-pack && gh auth switch --user kfrance 2>&1 && GH_TOKEN=$(gh auth token) git -c "http.https://github.com/.extraheader=Authorization: basic $(echo -n "x-access-token:$(gh auth token)" | base64 -w0)" push 2>&1',
				true,
				"blocks git push wrapped in gh auth switch and git -c with complex value",
			],
			[
				'GH_TOKEN=$(gh auth token) git -c "http.https://github.com/.extraheader=Authorization: basic token" push origin main',
				true,
				"blocks git push with GH_TOKEN env and -c config",
			],
			[
				'git -c credential.helper="!gh auth token" push origin main',
				true,
				"blocks git push with credential helper override",
			],
			[
				'git -c "user.email=fake@test.com" -c "user.name=Fake" commit -m "spoof"',
				true,
				"blocks git commit with spoofed author via -c flags",
			],
			[
				"ssh remote-host 'cd /repo && git push origin main'",
				true,
				"blocks git push inside ssh command string",
			],
		]);
	});

	describe("whitespace and formatting edge cases", () => {
		runCases([
			["git  add .", true, "blocks git add with double space"],
			["git\tcommit -m 'msg'", true, "blocks git commit with tab"],
			["  git push origin main", true, "blocks git push with leading whitespace"],
			["git   -c   key=val   push   origin", true, "blocks git push with excessive whitespace in global options"],
		]);
	});

	describe("intentional false positives (prefer safety over precision)", () => {
		runCases([
			["echo 'run git add . to stage changes'", true, "blocks echo containing git add (intentional)"],
			["grep 'git push' deploy.log", true, "blocks grep for git push (intentional)"],
			["# git push origin main", true, "blocks comment mentioning git push (intentional)"],
		]);
	});

	describe("should NOT match (no false blocking)", () => {
		runCases([
			["git status", false, "allows git status"],
			["git log --oneline -10", false, "allows git log"],
			["git diff HEAD~1", false, "allows git diff"],
			["git show HEAD:src/main.ts", false, "allows git show"],
			["git branch", false, "allows git branch (list)"],
			["git branch -a", false, "allows git branch -a"],
			["git remote -v", false, "allows git remote -v"],
			["git fetch origin", false, "allows git fetch"],
			["git checkout feature-branch", false, "allows git checkout (branch switch)"],
			["git blame src/main.ts", false, "allows git blame"],
			["ls -la", false, "allows non-git commands"],
			["cat README.md", false, "allows cat"],
			["grep -r 'TODO' src/", false, "allows grep"],
			["./git-push-helper.sh", false, "allows hyphenated git-push script"],
			["cat commit.txt", false, "allows reading file called commit.txt"],
			["cat docs/git-commit.md", false, "allows reading file called git-commit.md"],
		]);
	});

	describe("log directory resolution", () => {
		it("uses XDG_STATE_HOME when provided", () => {
			assert.strictEqual(
				resolveLogDirectory({ XDG_STATE_HOME: "/tmp/pi-state" } as NodeJS.ProcessEnv, "/ignored-home"),
				path.join("/tmp/pi-state", "kfrance-pi-pack", "command-gate"),
			);
		});

		it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
			assert.strictEqual(
				resolveLogDirectory({} as NodeJS.ProcessEnv, "/tmp/test-home"),
				path.join("/tmp/test-home", ".local", "state", "kfrance-pi-pack", "command-gate"),
			);
		});
	});

	describe("JSONL logging", () => {
		it("appends one JSON record per command", async () => {
			const logDir = await mkdtemp(path.join(os.tmpdir(), "command-gate-"));

			try {
				const entry = {
					timestamp: "2026-04-03T17:00:00.000Z",
					toolName: "bash" as const,
					pid: 12345,
					command: "git status",
					matched: false,
					decision: "allowed" as const,
					decisionReason: "no pattern matched",
					hasUI: true,
				};

				const logPath = await appendCommandGateLog(entry, { logDir, maxBytes: 1024 });
				const content = await readFile(logPath, "utf8");
				const lines = content.trim().split("\n");

				assert.strictEqual(lines.length, 1);
				assert.deepStrictEqual(JSON.parse(lines[0]), entry);
			} finally {
				await rm(logDir, { recursive: true, force: true });
			}
		});

		it("rotates the active log when the next write would exceed the size limit", async () => {
			const logDir = await mkdtemp(path.join(os.tmpdir(), "command-gate-"));

			try {
				const activeLogPath = getActiveLogPath(logDir);
				await mkdir(logDir, { recursive: true });
				await writeFile(activeLogPath, "x".repeat(60), "utf8");

				const entry = {
					timestamp: "2026-04-03T17:01:00.000Z",
					toolName: "bash" as const,
					pid: 12345,
					command: "gog send --to test@example.com --subject hi",
					matched: true,
					matchReason: "gog usage",
					decision: "confirmed" as const,
					decisionReason: "confirmed by user",
					hasUI: true,
				};

				await appendCommandGateLog(entry, { logDir, maxBytes: 64 });

				assert.strictEqual(await readFile(path.join(logDir, "command-gate.jsonl.1"), "utf8"), "x".repeat(60));
				assert.deepStrictEqual(JSON.parse(await readFile(activeLogPath, "utf8")), entry);
			} finally {
				await rm(logDir, { recursive: true, force: true });
			}
		});

		it("serializes concurrent appends with a lock file", async () => {
			const logDir = await mkdtemp(path.join(os.tmpdir(), "command-gate-"));

			try {
				const entries = [
					{
						timestamp: "2026-04-03T17:02:00.000Z",
						toolName: "bash" as const,
						pid: 111,
						command: "git status",
						matched: false,
						decision: "allowed" as const,
						decisionReason: "no pattern matched",
						hasUI: true,
					},
					{
						timestamp: "2026-04-03T17:02:01.000Z",
						toolName: "bash" as const,
						pid: 222,
						command: "gog send --to test@example.com --subject hi",
						matched: true,
						matchReason: "gog usage",
						decision: "confirmed" as const,
						decisionReason: "confirmed by user",
						hasUI: true,
					},
				];

				await Promise.all(entries.map((entry) => appendCommandGateLog(entry, { logDir, maxBytes: 1024 })));

				const activeLogPath = getActiveLogPath(logDir);
				const lines = (await readFile(activeLogPath, "utf8")).trim().split("\n");
				const actualEntries = lines.map((line) => JSON.parse(line));

				assert.strictEqual(lines.length, 2);
				assert.deepStrictEqual(
					actualEntries.map((entry) => entry.command).sort(),
					entries.map((entry) => entry.command).sort(),
				);
				assert.deepStrictEqual(
					actualEntries.map((entry) => entry.decision).sort(),
					entries.map((entry) => entry.decision).sort(),
				);
				await assert.rejects(readFile(getLogLockPath(logDir), "utf8"));
			} finally {
				await rm(logDir, { recursive: true, force: true });
			}
		});

		it("recovers from a stale lock file", async () => {
			const logDir = await mkdtemp(path.join(os.tmpdir(), "command-gate-"));

			try {
				await mkdir(logDir, { recursive: true });
				const lockPath = getLogLockPath(logDir);
				await writeFile(lockPath, "stale", "utf8");
				const staleDate = new Date(Date.now() - 60_000);
				await utimes(lockPath, staleDate, staleDate);

				const entry = {
					timestamp: "2026-04-03T17:03:00.000Z",
					toolName: "bash" as const,
					pid: 333,
					command: "git status",
					matched: false,
					decision: "allowed" as const,
					decisionReason: "no pattern matched",
					hasUI: true,
				};

				await appendCommandGateLog(entry, { logDir, maxBytes: 1024 });

				assert.deepStrictEqual(JSON.parse(await readFile(getActiveLogPath(logDir), "utf8")), entry);
				await assert.rejects(readFile(lockPath, "utf8"));
			} finally {
				await rm(logDir, { recursive: true, force: true });
			}
		});

		it("keeps incrementing numbered archives without a cap", async () => {
			const logDir = await mkdtemp(path.join(os.tmpdir(), "command-gate-"));

			try {
				await mkdir(logDir, { recursive: true });
				await writeFile(path.join(logDir, "command-gate.jsonl.1"), "old-1", "utf8");
				await writeFile(path.join(logDir, "command-gate.jsonl.7"), "old-7", "utf8");

				assert.strictEqual(await getNextRotatedLogPath(logDir), path.join(logDir, "command-gate.jsonl.8"));
			} finally {
				await rm(logDir, { recursive: true, force: true });
			}
		});
	});

	describe("extension integration", () => {
		it("logs allowed bash commands without prompting", async () => {
			const stateHome = await mkdtemp(path.join(os.tmpdir(), "command-gate-state-"));
			const previousXdgStateHome = process.env.XDG_STATE_HOME;
			let selectCalls = 0;

			try {
				process.env.XDG_STATE_HOME = stateHome;
				const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
				commandGateExtension({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);

				const result = await handlers.tool_call(
					{ toolName: "bash", input: { command: "git status" } },
					{ hasUI: true, ui: { select: async () => { selectCalls += 1; return "Yes"; } } },
				);

				assert.strictEqual(result, undefined);
				assert.strictEqual(selectCalls, 0);

				const logPath = getActiveLogPath(resolveLogDirectory(process.env, os.homedir()));
				const entry = JSON.parse(await readFile(logPath, "utf8"));
				assert.strictEqual(entry.command, "git status");
				assert.strictEqual(entry.matched, false);
				assert.strictEqual(entry.decision, "allowed");
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env.XDG_STATE_HOME;
				} else {
					process.env.XDG_STATE_HOME = previousXdgStateHome;
				}
				await rm(stateHome, { recursive: true, force: true });
			}
		});

		it("blocks gated commands without UI and logs the block decision", async () => {
			const stateHome = await mkdtemp(path.join(os.tmpdir(), "command-gate-state-"));
			const previousXdgStateHome = process.env.XDG_STATE_HOME;

			try {
				process.env.XDG_STATE_HOME = stateHome;
				const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
				commandGateExtension({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);

				const result = await handlers.tool_call(
					{ toolName: "bash", input: { command: "gog send --to test@example.com --subject hi" } },
					{ hasUI: false },
				);

				assert.deepStrictEqual(result, { block: true, reason: "Gated command blocked (no UI for confirmation)" });

				const logPath = getActiveLogPath(resolveLogDirectory(process.env, os.homedir()));
				const entry = JSON.parse(await readFile(logPath, "utf8"));
				assert.strictEqual(entry.matched, true);
				assert.strictEqual(entry.matchReason, "gog usage");
				assert.strictEqual(entry.decision, "blocked");
				assert.strictEqual(entry.decisionReason, "no UI available for confirmation");
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env.XDG_STATE_HOME;
				} else {
					process.env.XDG_STATE_HOME = previousXdgStateHome;
				}
				await rm(stateHome, { recursive: true, force: true });
			}
		});

		it("prompts for gated commands and logs confirmation decisions", async () => {
			const stateHome = await mkdtemp(path.join(os.tmpdir(), "command-gate-state-"));
			const previousXdgStateHome = process.env.XDG_STATE_HOME;
			let promptMessage = "";
			let promptChoices: string[] = [];

			try {
				process.env.XDG_STATE_HOME = stateHome;
				const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
				commandGateExtension({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);

				const result = await handlers.tool_call(
					{ toolName: "bash", input: { command: "gh api repos/owner/repo/issues -f title='bug'" } },
					{
						hasUI: true,
						ui: {
							select: async (message: string, choices: string[]) => {
								promptMessage = message;
								promptChoices = choices;
								return "Yes";
							},
						},
					},
				);

				assert.strictEqual(result, undefined);
				assert.match(promptMessage, /gh api repos\/owner\/repo\/issues -f title='bug'/);
				assert.deepStrictEqual(promptChoices, ["Yes", "No"]);

				const logPath = getActiveLogPath(resolveLogDirectory(process.env, os.homedir()));
				const entry = JSON.parse(await readFile(logPath, "utf8"));
				assert.strictEqual(entry.matchReason, "gh api implicit POST via fields\/input");
				assert.strictEqual(entry.decision, "confirmed");
				assert.strictEqual(entry.decisionReason, "confirmed by user");
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env.XDG_STATE_HOME;
				} else {
					process.env.XDG_STATE_HOME = previousXdgStateHome;
				}
				await rm(stateHome, { recursive: true, force: true });
			}
		});
	});
});
