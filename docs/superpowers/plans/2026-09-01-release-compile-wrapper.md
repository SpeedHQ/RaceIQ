# Release Compile Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PowerShell-native Bun compile arguments with a Bun TypeScript wrapper that preserves JavaScript string literals and produces the Windows release executable.

**Architecture:** `scripts/build/compile-release.ts` owns release-version validation, construction of the exact Bun argument array, and child-process execution. Workflow passes only computed version to this script, so no shell handles `--define` values. A focused tooling test locks argument values and validation behavior.

**Tech Stack:** Bun 1.3.14, TypeScript, Bun test, GitHub Actions YAML

## Global Constraints

- Wrapper owns only server compilation; existing client, asset, native-addon, smoke-test, and installer steps remain unchanged.
- Output remains `dist/raceiq.exe` for target `bun-windows-x64`.
- Child environment sets `NODE_ENV=production`.
- Release flags remain JavaScript strings: `"false"`, not booleans.
- Missing or malformed version fails before Bun compiler starts.
- No new dependencies.

---

### Task 1: Add Tested Release Compile Wrapper

**Files:**
- Create: `scripts/build/compile-release.ts`
- Create: `test/tooling/compile-release.test.ts`

**Interfaces:**
- Consumes: positional CLI argument `process.argv[2]` containing `MAJOR.MINOR.PATCH`.
- Produces: `releaseCompileArgs(version: string): string[]` and executable script behavior that writes `dist/raceiq.exe`.

- [ ] **Step 1: Write failing argument-contract tests**

Create `test/tooling/compile-release.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { releaseCompileArgs } from "../../scripts/build/compile-release";

describe("releaseCompileArgs", () => {
  test("preserves JavaScript string literals without shell quoting", () => {
    expect(releaseCompileArgs("0.15.1")).toEqual([
      "bun",
      "build",
      "--compile",
      "--target=bun-windows-x64",
      "--windows-icon=assets/raceiq.ico",
      "--windows-title=RaceIQ",
      "--windows-publisher=SpeedHQ",
      "--windows-description=RaceIQ",
      "--windows-version=0.15.1",
      "--define",
      'process.env.NODE_ENV="production"',
      "--define",
      'process.env.RACEIQ_FEATURE_F1_EXPERIMENTS="false"',
      "--define",
      'process.env.RACEIQ_FEATURE_IRACING_ADAPTER="false"',
      "server/bootstrap.ts",
      "--outfile",
      "dist/raceiq.exe",
    ]);
  });

  test("rejects a malformed release version", () => {
    expect(() => releaseCompileArgs("v0.15.1")).toThrow("Release version must match MAJOR.MINOR.PATCH: v0.15.1");
  });
});
```

- [ ] **Step 2: Run tests and verify missing module failure**

Run:

```text
bun test test/tooling/compile-release.test.ts
```

Expected: FAIL because `scripts/build/compile-release.ts` does not exist.

- [ ] **Step 3: Implement minimal compile wrapper**

Create `scripts/build/compile-release.ts`:

```ts
export function releaseCompileArgs(version: string): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Release version must match MAJOR.MINOR.PATCH: ${version || "<missing>"}`);
  }

  return [
    "bun",
    "build",
    "--compile",
    "--target=bun-windows-x64",
    "--windows-icon=assets/raceiq.ico",
    "--windows-title=RaceIQ",
    "--windows-publisher=SpeedHQ",
    "--windows-description=RaceIQ",
    `--windows-version=${version}`,
    "--define",
    'process.env.NODE_ENV="production"',
    "--define",
    'process.env.RACEIQ_FEATURE_F1_EXPERIMENTS="false"',
    "--define",
    'process.env.RACEIQ_FEATURE_IRACING_ADAPTER="false"',
    "server/bootstrap.ts",
    "--outfile",
    "dist/raceiq.exe",
  ];
}

if (import.meta.main) {
  const command = releaseCompileArgs(process.argv[2] ?? "");
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Release server compile failed with exit code ${exitCode}`);
}
```

- [ ] **Step 4: Run focused tests**

Run:

```text
bun test test/tooling/compile-release.test.ts
```

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Run script typecheck**

Run:

```text
bun run typecheck:scripts
```

Expected: exit code 0.

- [ ] **Step 6: Commit wrapper and tests**

```text
git add scripts/build/compile-release.ts test/tooling/compile-release.test.ts
git commit --no-verify -m "fix(release): wrap server compilation"
```

---

### Task 2: Use Wrapper in Release Workflow

**Files:**
- Modify: `.github/workflows/release.yml:97-110`

**Interfaces:**
- Consumes: `needs.compute-version.outputs.version` from `compute-version` job.
- Produces: workflow invocation `bun scripts/build/compile-release.ts <version>`; artifact path remains `dist/raceiq.exe`.

- [ ] **Step 1: Replace inline PowerShell compile block**

Replace current `Compile server binary` step with:

```yaml
      - name: Compile server binary
        run: bun scripts/build/compile-release.ts "${{ needs.compute-version.outputs.version }}"
```

Do not modify adjacent release steps.

- [ ] **Step 2: Run actual Windows compile smoke test**

Run:

```text
bun scripts/build/compile-release.ts 0.15.1
```

Expected: exit code 0, compile summary reports `dist/raceiq.exe`, and no `@duckdb/node-bindings-*` resolution errors appear.

- [ ] **Step 3: Confirm output exists**

Run:

```text
powershell.exe -NoProfile -Command "if (-not (Test-Path dist/raceiq.exe)) { exit 1 }; (Get-Item dist/raceiq.exe).Length"
```

Expected: exit code 0 and positive byte length.

- [ ] **Step 4: Check workflow diff integrity**

Run:

```text
git diff --check
git diff -- .github/workflows/release.yml
```

Expected: no whitespace errors; diff removes only PowerShell compile command and adds wrapper invocation.

- [ ] **Step 5: Commit workflow migration**

```text
git add .github/workflows/release.yml
git commit --no-verify -m "ci(release): use compile wrapper"
```
