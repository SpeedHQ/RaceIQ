# oxc Toolchain Setup

## Goal

Replace ESLint with oxlint and add oxc formatter across the entire codebase (server, client, shared). Add pre-commit hook to enforce linting and formatting on every commit.

## What Changes

### Added
- **oxlint** — fast linter covering server, client, shared
- **oxc formatter** — code formatter for all TypeScript files
- **simple-git-hooks** — lightweight git hook manager
- **lint-staged** — run linters on staged files only

### Removed
- ESLint and all related packages (`eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`)
- `client/eslint.config.js`

## Configuration

### `.oxlintrc.json` (root)
- Enable categories: `correctness`, `typescript`, `react`, `import`
- Ignore: `dist/`, `node_modules/`, `client/src/routeTree.gen.ts`

### Root `package.json` scripts
- `lint` — `oxlint .`
- `format` — `oxc format --write .`
- `format:check` — `oxc format --check .`

### Pre-commit hook
- **simple-git-hooks** config in `package.json`:
  - `pre-commit` → `bunx lint-staged`
- **lint-staged** config in `package.json`:
  - `*.{ts,tsx}` → `["oxlint", "oxc format --check"]`

### Client `package.json`
- Remove `lint` script (now handled at root)
- Remove all ESLint devDependencies

## Rollout Steps

1. Create branch `feat/oxc`
2. Install oxlint, oxc formatter, simple-git-hooks, lint-staged
3. Add `.oxlintrc.json` config
4. Add scripts and hook config to root `package.json`
5. Remove ESLint from client
6. Run formatter on entire codebase (single commit)
7. Set up pre-commit hook (`bunx simple-git-hooks`)
8. Update CLAUDE.md with new commands
9. Verify: run lint, format check, test
