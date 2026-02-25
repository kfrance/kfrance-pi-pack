import { describe, it } from "node:test";
import assert from "node:assert";
import { isWriteCommand } from "../extensions/git-gh-write-gate.ts";

// Each entry: [command, shouldBlock, description]
type TestCase = [string, boolean, string];

function runCases(cases: TestCase[]) {
	for (const [command, shouldBlock, description] of cases) {
		it(description, () => {
			assert.strictEqual(isWriteCommand(command), shouldBlock, `Command: ${command}`);
		});
	}
}

describe("git-gh-write-gate", () => {
	describe("gh API write methods", () => {
		runCases([
			["gh api repos/owner/repo/pulls/1/comments -X POST -f body='hi'", true, "blocks gh api -X POST"],
			["gh api repos/owner/repo/issues/1 -X DELETE", true, "blocks gh api -X DELETE"],
			["gh api repos/owner/repo/pulls/1 -X PATCH -f title='new'", true, "blocks gh api -X PATCH"],
			["gh api repos/owner/repo/pulls/1/merge -X PUT", true, "blocks gh api -X PUT"],
			["gh api repos/owner/repo/comments --method POST -f body='hi'", true, "blocks gh api --method POST"],
			["gh api repos/owner/repo/pulls/302", false, "allows gh api GET (default)"],
			["gh api repos/owner/repo/pulls/302/comments --jq '.[]'", false, "allows gh api with --jq"],
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
			["git tag -d v1.0.0", true, "blocks git tag -d"],
		]);
	});

	describe("git with global options between git and subcommand", () => {
		runCases([
			['git -c key=val push origin main', true, "blocks git -c key=val push"],
			['git -C /project add .', true, "blocks git -C /project add"],
			['git --no-pager commit -m "msg"', true, "blocks git --no-pager commit"],
			['git --git-dir=.git push origin main', true, "blocks git --git-dir=.git push"],
			['git --work-tree=/project reset --hard HEAD', true, "blocks git --work-tree=... reset"],
			['git -c "http.https://github.com/.extraheader=Authorization: basic stuff" push 2>&1', true, "blocks git -c with quoted value push"],
			["git -c 'user.name=Test' commit -m 'msg'", true, "blocks git -c with single-quoted value commit"],
			['git -C /tmp -c key=val push origin main', true, "blocks git with multiple global options push"],
			['git --no-pager --git-dir=.git add .', true, "blocks git with multiple long options add"],
			// Should NOT match subcommand appearing as a flag value
			['git log --format=push', false, "allows git log --format=push (push is a value, not subcommand)"],
			['git config push.default simple', false, "allows git config mentioning push as argument"],
			['git --no-pager log --oneline', false, "allows git --no-pager log (read-only)"],
			['git -C /project status', false, "allows git -C /project status (read-only)"],
			['git --git-dir=.git log --oneline', false, "allows git --git-dir log (read-only)"],
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
});
