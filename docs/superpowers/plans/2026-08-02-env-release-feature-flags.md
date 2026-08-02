# Environment-Driven Release Feature Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source F1 Experiments and iRacing release flags from committed root environment files instead of development-mode booleans.

**Architecture:** A strict shared parser converts two `RACEIQ_FEATURE_*` string values into the existing immutable flag object. Vite reads the root mode files for the browser, Bun development commands load the development file, and the production build loads then embeds production values into the compiled server.

**Tech Stack:** Bun, TypeScript, Vite, Bun test

## Global Constraints

- `.env.development` enables both flags; `.env.production` disables both.
- Client and server consume the same root files and variable names.
- Only exact `true` and `false` strings are valid; missing or malformed values fail with the variable name.
- No feature state derives from `import.meta.env.DEV`, `NODE_ENV`, or `IS_DEV`.
- Existing F1 and iRacing route, registration, and supervision consumers remain unchanged.

---

### Task 1: Strict environment flag parser

**Files:**
- Create: `.env.development`
- Create: `.env.production`
- Modify: `shared/release-feature-flags.ts`
- Modify: `test/release-feature-flags.test.ts`
- Modify: `test/release-game-registration.test.ts`
- Modify: `test/client-game-routes.test.ts`

**Interfaces:**
- Produces: `ReleaseFeatureFlagEnvironment` and `releaseFeatureFlags(env: ReleaseFeatureFlagEnvironment): ReleaseFeatureFlags`
- Consumes: exact `RACEIQ_FEATURE_F1_EXPERIMENTS` and `RACEIQ_FEATURE_IRACING_ADAPTER` strings

- [ ] **Step 1: Replace boolean-policy tests with failing environment contracts**

```ts
const developmentEnv = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "true",
  RACEIQ_FEATURE_IRACING_ADAPTER: "true",
};
const productionEnv = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "false",
  RACEIQ_FEATURE_IRACING_ADAPTER: "false",
};

expect(releaseFeatureFlags(developmentEnv)).toEqual({
  f1Experiments: true,
  iracingAdapter: true,
});
expect(releaseFeatureFlags(productionEnv)).toEqual({
  f1Experiments: false,
  iracingAdapter: false,
});
expect(() => releaseFeatureFlags({ ...developmentEnv, RACEIQ_FEATURE_F1_EXPERIMENTS: undefined }))
  .toThrow("RACEIQ_FEATURE_F1_EXPERIMENTS");
expect(() => releaseFeatureFlags({ ...developmentEnv, RACEIQ_FEATURE_IRACING_ADAPTER: "yes" }))
  .toThrow("RACEIQ_FEATURE_IRACING_ADAPTER");
```

Also launch Bun subprocesses with `--env-file=.env.development` and `--env-file=.env.production`; parse their JSON output and assert the committed files resolve to the expected objects.

- [ ] **Step 2: Run tests and record expected RED**

Run: `bun test test/release-feature-flags.test.ts test/release-game-registration.test.ts test/client-game-routes.test.ts`

Expected: FAIL because `releaseFeatureFlags` still accepts a boolean.

- [ ] **Step 3: Add environment files and strict parser**

```dotenv
# .env.development
RACEIQ_FEATURE_F1_EXPERIMENTS=true
RACEIQ_FEATURE_IRACING_ADAPTER=true
```

```dotenv
# .env.production
RACEIQ_FEATURE_F1_EXPERIMENTS=false
RACEIQ_FEATURE_IRACING_ADAPTER=false
```

```ts
export interface ReleaseFeatureFlagEnvironment {
  readonly RACEIQ_FEATURE_F1_EXPERIMENTS: string | undefined;
  readonly RACEIQ_FEATURE_IRACING_ADAPTER: string | undefined;
}

function booleanFlag(name: keyof ReleaseFeatureFlagEnvironment, value: string | undefined): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${name}: expected \"true\" or \"false\"`);
}

export function releaseFeatureFlags(env: ReleaseFeatureFlagEnvironment): ReleaseFeatureFlags {
  return {
    f1Experiments: booleanFlag("RACEIQ_FEATURE_F1_EXPERIMENTS", env.RACEIQ_FEATURE_F1_EXPERIMENTS),
    iracingAdapter: booleanFlag("RACEIQ_FEATURE_IRACING_ADAPTER", env.RACEIQ_FEATURE_IRACING_ADAPTER),
  };
}
```

Update focused route and registration tests to pass `developmentEnv` and `productionEnv` instead of booleans, including `initGameAdapters(developmentEnv)` in the route test.

- [ ] **Step 4: Run focused parser and behavior tests**

Run: `bun test test/release-feature-flags.test.ts test/release-game-registration.test.ts test/client-game-routes.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add .env.development .env.production shared/release-feature-flags.ts test/release-feature-flags.test.ts test/release-game-registration.test.ts test/client-game-routes.test.ts
git commit -m "feat: source release flags from env files"
```

### Task 2: Wire client and server build boundaries

**Files:**
- Modify: `client/vite.config.ts`
- Modify: `client/src/lib/release-features.ts`
- Modify: `shared/games/init.ts`
- Modify: `server/games/init.ts`
- Modify: `server/index.ts`
- Modify: `test/setup-data-dir.ts`
- Modify: `scripts/build.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `releaseFeatureFlags(env)` from Task 1
- Produces: `clientReleaseFeatures` from `import.meta.env.RACEIQ_*` and server `releaseFeatures` from `process.env.RACEIQ_*`

- [ ] **Step 1: Run compile boundary and record expected RED**

Run: `cd client && bun run build`

Expected: FAIL because client startup and adapter initializer defaults still pass booleans to the environment-shaped parser.

- [ ] **Step 2: Bind Vite and runtime entrypoints**

Configure Vite with repository-root `envDir` and `envPrefix: ["VITE_", "RACEIQ_"]`.

```ts
export const clientReleaseFeatures = releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: import.meta.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
  RACEIQ_FEATURE_IRACING_ADAPTER: import.meta.env.RACEIQ_FEATURE_IRACING_ADAPTER,
});
```

```ts
const releaseFeatures = releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
  RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
});
```

Remove client `isDevelopment` and server `IS_DEV` imports from release-feature resolution. Change shared and server adapter initializer defaults from `releaseFeatureFlags(true)` to `releaseFeatureFlags(process.env)`, so legacy Bun test/tool callers consume configured environment values without an in-code development boolean.

- [ ] **Step 3: Load mode files for development, tests, and production builds**

Set root scripts to load `.env.development` for server development commands and `.env.production` for `build`. Extend `test/setup-data-dir.ts` to load the two `RACEIQ_FEATURE_*` assignments from `.env.development` into `process.env` before test modules initialize adapters. In `scripts/build.ts`, validate both variables through `releaseFeatureFlags(process.env)`, then append these exact compile arguments:

```ts
compileArgs.push(
  "--define",
  `process.env.RACEIQ_FEATURE_F1_EXPERIMENTS=${JSON.stringify(process.env.RACEIQ_FEATURE_F1_EXPERIMENTS)}`,
  "--define",
  `process.env.RACEIQ_FEATURE_IRACING_ADAPTER=${JSON.stringify(process.env.RACEIQ_FEATURE_IRACING_ADAPTER)}`,
);
```

- [ ] **Step 4: Run focused tests and builds**

Run: `bun test test/release-feature-flags.test.ts test/release-game-registration.test.ts test/client-game-routes.test.ts test/changelog.test.ts --timeout 60000`

Run: `cd client && bun run build`

Run: `bun run build`

Expected: focused tests and client build pass; root build either passes or reaches the previously documented external DuckDB optional-binding blocker after compiling feature-flag code.

- [ ] **Step 5: Browser-smoke both modes**

Production: F1 sidebar has no Experiments, direct F1 experiment routes reject, iRacing is absent, ACC retains Experiments.

Development: F1 Experiments and iRacing are visible.

- [ ] **Step 6: Commit and update PR**

```bash
git add client/vite.config.ts client/src/lib/release-features.ts shared/games/init.ts server/games/init.ts server/index.ts test/setup-data-dir.ts scripts/build.ts package.json
git commit -m "build: bind release flags to mode env files"
git push
```
