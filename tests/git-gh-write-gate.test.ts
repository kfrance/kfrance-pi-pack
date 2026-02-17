import { describe, it } from "node:test";
import assert from "node:assert";
import { isWriteCommand } from "../extensions/git-gh-write-gate.ts";

describe("git-gh-write-gate", () => {
	describe("gh API write methods", () => {
		it("blocks gh api POST", () => {
			assert.ok(isWriteCommand("gh api repos/owner/repo/pulls/1/comments -X POST -f body='hi'"));
		});

		it("blocks gh api DELETE", () => {
			assert.ok(isWriteCommand("gh api repos/owner/repo/issues/1 -X DELETE"));
		});

		it("blocks gh api PATCH", () => {
			assert.ok(isWriteCommand("gh api repos/owner/repo/pulls/1 -X PATCH -f title='new'"));
		});

		it("blocks gh api PUT", () => {
			assert.ok(isWriteCommand("gh api repos/owner/repo/pulls/1/merge -X PUT"));
		});

		it("blocks gh api --method POST", () => {
			assert.ok(isWriteCommand("gh api repos/owner/repo/comments --method POST -f body='hi'"));
		});

		it("allows gh api GET (default)", () => {
			assert.ok(!isWriteCommand("gh api repos/owner/repo/pulls/302"));
		});

		it("allows gh api with --jq", () => {
			assert.ok(!isWriteCommand("gh api repos/owner/repo/pulls/302/comments --jq '.[]'"));
		});
	});

	describe("gh CLI write commands", () => {
		it("blocks gh pr create", () => {
			assert.ok(isWriteCommand("gh pr create --title 'test' --body 'test'"));
		});

		it("blocks gh pr merge", () => {
			assert.ok(isWriteCommand("gh pr merge 302 --squash"));
		});

		it("blocks gh pr comment", () => {
			assert.ok(isWriteCommand("gh pr comment 302 --body 'looks good'"));
		});

		it("blocks gh pr close", () => {
			assert.ok(isWriteCommand("gh pr close 302"));
		});

		it("blocks gh pr review", () => {
			assert.ok(isWriteCommand("gh pr review 302 --approve"));
		});

		it("blocks gh issue create", () => {
			assert.ok(isWriteCommand("gh issue create --title 'bug'"));
		});

		it("blocks gh issue comment", () => {
			assert.ok(isWriteCommand("gh issue comment 42 --body 'fixed'"));
		});

		it("blocks gh issue close", () => {
			assert.ok(isWriteCommand("gh issue close 42"));
		});

		it("blocks gh release create", () => {
			assert.ok(isWriteCommand("gh release create v1.0.0"));
		});

		it("allows gh pr view", () => {
			assert.ok(!isWriteCommand("gh pr view 302"));
		});

		it("allows gh pr list", () => {
			assert.ok(!isWriteCommand("gh pr list --state open"));
		});

		it("allows gh issue list", () => {
			assert.ok(!isWriteCommand("gh issue list"));
		});

		it("allows gh pr view with json", () => {
			assert.ok(!isWriteCommand("gh pr view 302 --json title,body"));
		});
	});

	describe("git state-changing commands", () => {
		it("blocks git add", () => {
			assert.ok(isWriteCommand("git add ."));
		});

		it("blocks git add with path", () => {
			assert.ok(isWriteCommand("git add src/main.ts"));
		});

		it("blocks git commit", () => {
			assert.ok(isWriteCommand('git commit -m "fix bug"'));
		});

		it("blocks git push", () => {
			assert.ok(isWriteCommand("git push origin main"));
		});

		it("blocks git push --force", () => {
			assert.ok(isWriteCommand("git push --force origin main"));
		});

		it("blocks git push -f", () => {
			assert.ok(isWriteCommand("git push -f origin main"));
		});

		it("blocks git rebase", () => {
			assert.ok(isWriteCommand("git rebase main"));
		});

		it("blocks git rebase interactive", () => {
			assert.ok(isWriteCommand("git rebase -i HEAD~3"));
		});

		it("blocks git reset", () => {
			assert.ok(isWriteCommand("git reset --hard HEAD~1"));
		});

		it("blocks git reset soft", () => {
			assert.ok(isWriteCommand("git reset --soft HEAD~1"));
		});

		it("blocks git merge", () => {
			assert.ok(isWriteCommand("git merge feature-branch"));
		});

		it("blocks git cherry-pick", () => {
			assert.ok(isWriteCommand("git cherry-pick abc123"));
		});

		it("blocks git revert", () => {
			assert.ok(isWriteCommand("git revert HEAD"));
		});

		it("blocks git stash", () => {
			assert.ok(isWriteCommand("git stash"));
		});

		it("blocks git stash pop", () => {
			assert.ok(isWriteCommand("git stash pop"));
		});

		it("blocks git clean", () => {
			assert.ok(isWriteCommand("git clean -fd"));
		});

		it("blocks git restore", () => {
			assert.ok(isWriteCommand("git restore src/main.ts"));
		});

		it("blocks git checkout -- (file restore)", () => {
			assert.ok(isWriteCommand("git checkout -- src/main.ts"));
		});

		it("blocks git branch -d", () => {
			assert.ok(isWriteCommand("git branch -d old-branch"));
		});

		it("blocks git branch -D", () => {
			assert.ok(isWriteCommand("git branch -D old-branch"));
		});

		it("blocks git tag -d", () => {
			assert.ok(isWriteCommand("git tag -d v1.0.0"));
		});
	});

	describe("compound commands (&&, ||, ;, pipes)", () => {
		it("blocks git add after && chain", () => {
			assert.ok(isWriteCommand("cd /data/project && git add ."));
		});

		it("blocks git commit in && chain", () => {
			assert.ok(isWriteCommand('git add . && git commit -m "update"'));
		});

		it("blocks git push in && chain", () => {
			assert.ok(isWriteCommand('git add . && git commit -m "update" && git push origin main'));
		});

		it("blocks git reset after || fallback", () => {
			assert.ok(isWriteCommand("git merge feature || git reset --hard HEAD"));
		});

		it("blocks git add after semicolon", () => {
			assert.ok(isWriteCommand("echo 'done'; git add ."));
		});

		it("blocks git commit after semicolon", () => {
			assert.ok(isWriteCommand('ls -la; git commit -m "quick fix"'));
		});

		it("blocks gh api POST in && chain", () => {
			assert.ok(isWriteCommand("echo 'posting' && gh api repos/owner/repo/comments -X POST -f body='hi'"));
		});

		it("blocks git push piped from other command", () => {
			assert.ok(isWriteCommand("echo 'pushing' | tee log.txt && git push origin main"));
		});

		it("blocks git rebase in complex chain", () => {
			assert.ok(isWriteCommand("git fetch origin && git rebase origin/main && echo 'done'"));
		});

		it("allows read-only && chain", () => {
			assert.ok(!isWriteCommand("git fetch origin && git log --oneline -5"));
		});

		it("allows read-only semicolon chain", () => {
			assert.ok(!isWriteCommand("git status; git diff"));
		});

		it("allows piped read-only commands", () => {
			assert.ok(!isWriteCommand("git log --oneline | head -20"));
		});

		it("allows git diff piped to grep", () => {
			assert.ok(!isWriteCommand("git diff HEAD~1 | grep 'TODO'"));
		});
	});

	describe("subshells and command substitution", () => {
		it("blocks git add inside subshell", () => {
			assert.ok(isWriteCommand("(cd /project && git add .)"));
		});

		it("blocks git commit inside subshell", () => {
			assert.ok(isWriteCommand('(git add . && git commit -m "msg")'));
		});

		it("blocks git push inside $(...)", () => {
			assert.ok(isWriteCommand("echo $(git push origin main 2>&1)"));
		});

		it("blocks git reset inside backticks", () => {
			assert.ok(isWriteCommand("echo `git reset --hard HEAD`"));
		});

		it("blocks gh api POST inside subshell", () => {
			assert.ok(isWriteCommand("(gh api repos/o/r/comments -X POST -f body='hi')"));
		});

		it("allows read-only inside subshell", () => {
			assert.ok(!isWriteCommand("echo $(git log --oneline -1)"));
		});
	});

	describe("multiline commands", () => {
		it("blocks git add on second line", () => {
			assert.ok(isWriteCommand("cd /project\ngit add ."));
		});

		it("blocks git commit on third line", () => {
			assert.ok(isWriteCommand('cd /project\ngit add .\ngit commit -m "msg"'));
		});

		it("blocks git push in multiline script", () => {
			assert.ok(isWriteCommand("git add .\ngit commit -m 'update'\ngit push origin main"));
		});

		it("blocks gh api POST on later line", () => {
			assert.ok(isWriteCommand("BODY='hello'\ngh api repos/o/r/comments -X POST -f body=\"$BODY\""));
		});

		it("allows multiline read-only", () => {
			assert.ok(!isWriteCommand("git status\ngit log --oneline -5\ngit diff"));
		});
	});

	describe("environment variables and quoting", () => {
		it("blocks git push with env var prefix", () => {
			assert.ok(isWriteCommand("GIT_SSH_COMMAND='ssh -i key' git push origin main"));
		});

		it("blocks git commit with env var in message", () => {
			assert.ok(isWriteCommand('git commit -m "$COMMIT_MSG"'));
		});

		it("blocks git add with variable expansion in path", () => {
			assert.ok(isWriteCommand("git add ${FILE_PATH}"));
		});

		it("blocks gh api POST with quoted body", () => {
			assert.ok(isWriteCommand(`gh api repos/o/r/comments -X POST -f body="it's done"`));
		});

		it("blocks git push with variable branch", () => {
			assert.ok(isWriteCommand("git push origin $BRANCH_NAME"));
		});
	});

	describe("heredocs and redirections", () => {
		it("blocks git commit with heredoc-style message", () => {
			assert.ok(isWriteCommand('git commit -m "$(cat <<EOF\nLong message\nEOF\n)"'));
		});

		it("blocks gh api POST with redirect", () => {
			assert.ok(isWriteCommand("gh api repos/o/r/comments -X POST -f body='hi' > /dev/null"));
		});

		it("blocks git push with stderr redirect", () => {
			assert.ok(isWriteCommand("git push origin main 2>&1"));
		});

		it("blocks git stash with output redirect", () => {
			assert.ok(isWriteCommand("git stash 2>&1 | tee stash.log"));
		});
	});

	describe("conditional and loop constructs", () => {
		it("blocks git push inside if statement", () => {
			assert.ok(isWriteCommand("if [ -n \"$PUSH\" ]; then git push origin main; fi"));
		});

		it("blocks git add inside for loop", () => {
			assert.ok(isWriteCommand("for f in *.ts; do git add $f; done"));
		});

		it("blocks git commit inside while loop", () => {
			assert.ok(isWriteCommand('while true; do git commit -m "auto"; sleep 60; done'));
		});

		it("blocks gh api POST inside if", () => {
			assert.ok(isWriteCommand("if true; then gh api repos/o/r -X POST -f body='y'; fi"));
		});

		it("allows read-only inside if", () => {
			assert.ok(!isWriteCommand("if [ -d .git ]; then git status; fi"));
		});
	});

	describe("edge cases and false positives", () => {
		// These are intentional false positives — we prefer to over-prompt
		// rather than risk missing a real destructive command
		it("blocks echo containing git add as string (intentional false positive)", () => {
			assert.ok(isWriteCommand("echo 'run git add . to stage changes'"));
		});

		it("blocks grep for git push in logs (intentional false positive)", () => {
			assert.ok(isWriteCommand("grep 'git push' deploy.log"));
		});

		it("blocks comment-only lines mentioning git push (intentional false positive)", () => {
			assert.ok(isWriteCommand("# git push origin main"));
		});

		it("allows cat of a file named git-commit", () => {
			assert.ok(!isWriteCommand("cat docs/git-commit.md"));
		});

		it("blocks git add even with extra whitespace", () => {
			assert.ok(isWriteCommand("git  add ."));
		});

		it("blocks git commit with tab whitespace", () => {
			assert.ok(isWriteCommand("git\tcommit -m 'msg'"));
		});

		it("blocks git push even with leading whitespace", () => {
			assert.ok(isWriteCommand("  git push origin main"));
		});

		it("allows git-push (hyphenated, not a git command)", () => {
			assert.ok(!isWriteCommand("./git-push-helper.sh"));
		});

		it("allows reading a file called commit.txt", () => {
			assert.ok(!isWriteCommand("cat commit.txt"));
		});

		it("blocks gh pr edit", () => {
			assert.ok(isWriteCommand("gh pr edit 302 --title 'new title'"));
		});

		it("blocks gh issue delete", () => {
			assert.ok(isWriteCommand("gh issue delete 42"));
		});

		it("blocks gh issue transfer", () => {
			assert.ok(isWriteCommand("gh issue transfer 42 other-repo"));
		});

		it("blocks gh release delete", () => {
			assert.ok(isWriteCommand("gh release delete v1.0.0"));
		});

		it("blocks gh release edit", () => {
			assert.ok(isWriteCommand("gh release edit v1.0.0 --draft"));
		});
	});

	describe("read-only commands (should pass through)", () => {
		it("allows git status", () => {
			assert.ok(!isWriteCommand("git status"));
		});

		it("allows git log", () => {
			assert.ok(!isWriteCommand("git log --oneline -10"));
		});

		it("allows git diff", () => {
			assert.ok(!isWriteCommand("git diff HEAD~1"));
		});

		it("allows git show", () => {
			assert.ok(!isWriteCommand("git show HEAD:src/main.ts"));
		});

		it("allows git branch (list)", () => {
			assert.ok(!isWriteCommand("git branch"));
		});

		it("allows git branch -a", () => {
			assert.ok(!isWriteCommand("git branch -a"));
		});

		it("allows git remote -v", () => {
			assert.ok(!isWriteCommand("git remote -v"));
		});

		it("allows git fetch", () => {
			assert.ok(!isWriteCommand("git fetch origin"));
		});

		it("allows git checkout (branch switch)", () => {
			assert.ok(!isWriteCommand("git checkout feature-branch"));
		});

		it("allows git blame", () => {
			assert.ok(!isWriteCommand("git blame src/main.ts"));
		});

		it("allows non-git commands", () => {
			assert.ok(!isWriteCommand("ls -la"));
		});

		it("allows cat", () => {
			assert.ok(!isWriteCommand("cat README.md"));
		});

		it("allows grep", () => {
			assert.ok(!isWriteCommand("grep -r 'TODO' src/"));
		});
	});
});
