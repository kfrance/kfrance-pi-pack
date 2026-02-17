# kfrance-pi-pack

Personal [pi](https://github.com/badlogic/pi-mono) extensions, skills, and prompt templates.

## Installation

```bash
pi install git:github.com/kfrance/kfrance-pi-pack
```

## Extensions

### git-gh-write-gate

Requires user confirmation before executing destructive git or GitHub commands. Read-only commands pass through freely.

**Gated commands:**
- **GitHub writes:** `gh api -X POST/PUT/PATCH/DELETE`, `gh pr create/merge/comment`, `gh issue create/comment`, etc.
- **Git state changes:** `add`, `commit`, `push`, `rebase`, `reset`, `merge`, `cherry-pick`, `revert`, `stash`, `clean`, `restore`, branch/tag deletion, force push

**Allowed freely:**
- `git status`, `git log`, `git diff`, `git show`, `git fetch`, `git branch` (list), `git checkout` (branch switch)
- `gh pr view/list`, `gh issue list`, `gh api` (GET)

## Development

```bash
npm install
npm test
```

## License

MIT
