# Release Compile Wrapper Design

## Problem

Release workflow invokes `bun build` through Windows PowerShell. PowerShell removes embedded quotes from Bun `--define` argument values, so `process.env.NODE_ENV="production"` reaches Bun as a bare identifier rather than a string literal. Bun cannot eliminate development-only Mastra imports, follows `@mastra/duckdb`, and fails while resolving native bindings for platforms not installed on Windows.

## Decision

Move only server compilation into `scripts/build/compile-release.ts`. Keep dependency installation, client build, data copying, native-addon staging, smoke testing, and installer creation as separate workflow steps.

The script will accept one positional release version, validate it as `MAJOR.MINOR.PATCH`, and invoke `bun build` with `Bun.spawn`. Every argument will occupy its own array element, bypassing shell parsing and preserving quoted JavaScript string literals used by `--define`.

## Compile Contract

Invocation:

```text
bun scripts/build/compile-release.ts 0.15.1
```

The script will:

- set `NODE_ENV=production` in child environment;
- compile `server/bootstrap.ts` for `bun-windows-x64`;
- write `dist/raceiq.exe`;
- set RaceIQ icon, title, publisher, description, and supplied Windows version;
- define `process.env.NODE_ENV` as the JavaScript string `"production"`;
- define both release feature flags as JavaScript string `"false"`;
- inherit stdout and stderr;
- throw and exit nonzero when Bun compilation fails.

Missing or malformed version input will fail before spawning Bun with an actionable error.

## Workflow Change

Replace the inline PowerShell compile block with one shell-independent command:

```yaml
- name: Compile server binary
  run: bun scripts/build/compile-release.ts "${{ needs.compute-version.outputs.version }}"
```

No other release step changes.

## Verification

Run the wrapper with version `0.15.1` on Windows. Success requires:

- exit code zero;
- `dist/raceiq.exe` produced;
- no DuckDB native-binding resolution errors.

Run script TypeScript checking to cover argument and Bun API usage. Existing workflow smoke test remains responsible for proving the resulting executable starts and listens successfully.
