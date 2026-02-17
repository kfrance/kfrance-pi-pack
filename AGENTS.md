# kfrance-pi-pack

## Project Overview

A pi package containing personal extensions, skills, and prompt templates. Built with TypeScript, tested with Node's built-in test runner via tsx.

## Project Layout

```
kfrance-pi-pack/
├── extensions/          # Pi extensions (.ts files)
├── tests/               # Tests matching extensions (*.test.ts)
├── package.json         # Pi package manifest
└── AGENTS.md            # This file
```

## Development Rules

### Tests are mandatory
- **All tests must pass before any commit.** Run `npm test` and verify.
- **Every new extension must have a corresponding test file** in `tests/` named `<extension-name>.test.ts`.
- **Every new feature or pattern added to an existing extension must have test coverage.**
- Export testable logic as named functions (e.g., `isWriteCommand()`) so it can be unit tested without requiring a running pi agent.

### Running Tests

```bash
npm test
```

Uses Node's built-in test runner (`node:test` + `node:assert`) via tsx. No external test framework needed.

### Adding a New Extension

1. Create `extensions/my-extension.ts` with a default export function
2. Create `tests/my-extension.test.ts` with tests for exported logic
3. Run `npm test` to verify
4. Update `README.md` with documentation for the new extension

### Conventions

- Extensions export a default function `(pi: ExtensionAPI) => void` for pi to load
- Extract core logic into named exports for testability
- Use `node:test` (`describe`/`it`) and `node:assert` for tests
- Pi peer dependencies (`@mariozechner/pi-coding-agent`, `@sinclair/typebox`) use `"*"` range
