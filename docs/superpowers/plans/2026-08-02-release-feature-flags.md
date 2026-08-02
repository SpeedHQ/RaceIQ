# Release Feature Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep F1 Experiments and iRacing enabled for development while disabling F1 Experiments plus all iRacing registration, UI exposure, and native detection in production releases.

**Architecture:** A pure shared resolver owns release policy; client and server bind their environment signals at startup. Adapter selection and native-source selection become pure, testable functions consumed by existing initializers and supervisor code. Client route support receives the same resolved flags, preserving one policy across UI and server.

**Tech Stack:** TypeScript, Bun, React, Vite, TanStack Router

## Global Constraints

- `f1Experiments` and `iracingAdapter` are enabled outside production and disabled in production.
- F1 remains registered in production; only F1 Experiments is disabled.
- Production omits iRacing from client/shared and server adapter registries and skips iRacing process detection/source supervision.
- ACC and AC Evo Experiments and native-source supervision remain unchanged.
- Existing iRacing implementation/import tooling stays in source and may remain in compiled artifact bytes.
- Adapter initializers default to development behavior; client route helpers default to client environment flags and tests pass explicit flags.
- Work only in `.worktrees/featureflags-release-gates` on `feature/featureflags-release-gates`.

---

### Task 1: Shared Release Feature Policy

**Files:**
- Create: `shared/release-feature-flags.ts`
- Create: `test/release-feature-flags.test.ts`

**Interfaces:**
- Produces: `ReleaseFeatureFlags` and `releaseFeatureFlags(isDevelopment: boolean): ReleaseFeatureFlags`.
- Consumes: no runtime globals.

- [ ] **Step 1: Write failing policy tests**

```ts
import { describe, expect, test } from "bun:test";
import { releaseFeatureFlags } from "../shared/release-feature-flags";

describe("release feature flags", () => {
  test("enables unfinished integrations in development", () => {
    expect(releaseFeatureFlags(true)).toEqual({
      f1Experiments: true,
      iracingAdapter: true,
    });
  });

  test("disables unfinished integrations in production", () => {
    expect(releaseFeatureFlags(false)).toEqual({
      f1Experiments: false,
      iracingAdapter: false,
    });
  });
});
```

- [ ] **Step 2: Run test and verify missing-module failure**

Run: `bun test test/release-feature-flags.test.ts`

Expected: FAIL because `shared/release-feature-flags.ts` does not exist.

- [ ] **Step 3: Implement pure resolver**

```ts
export interface ReleaseFeatureFlags {
  readonly f1Experiments: boolean;
  readonly iracingAdapter: boolean;
}

export function releaseFeatureFlags(isDevelopment: boolean): ReleaseFeatureFlags {
  return {
    f1Experiments: isDevelopment,
    iracingAdapter: isDevelopment,
  };
}
```

- [ ] **Step 4: Run focused test**

Run: `bun test test/release-feature-flags.test.ts`

Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add shared/release-feature-flags.ts test/release-feature-flags.test.ts
git commit -m "feat: define release feature flags"
```

---

### Task 2: Environment-Aware Adapter Registration

**Files:**
- Modify: `shared/games/init.ts`
- Modify: `server/games/init.ts`
- Create: `client/src/lib/release-features.ts`
- Modify: `client/src/main.tsx`
- Modify: `server/index.ts`
- Create: `test/release-game-registration.test.ts`

**Interfaces:**
- Consumes: `ReleaseFeatureFlags`, `releaseFeatureFlags` from Task 1; client `isDevelopment` from `client/src/lib/env.ts`; server `IS_DEV` from `server/env.ts`.
- Produces: `gameAdaptersForFeatures(flags)`, `serverGameAdaptersForFeatures(flags)`, feature-aware initializers with development defaults, and client-bound `clientReleaseFeatures`.

- [ ] **Step 1: Write failing adapter-selection tests**

```ts
import { describe, expect, test } from "bun:test";
import { gameAdaptersForFeatures } from "../shared/games/init";
import { releaseFeatureFlags } from "../shared/release-feature-flags";
import { serverGameAdaptersForFeatures } from "../server/games/init";

const ids = (adapters: readonly { id: string }[]) => adapters.map((adapter) => adapter.id);

describe("release game registration", () => {
  test("includes iRacing in development registries", () => {
    const flags = releaseFeatureFlags(true);
    expect(ids(gameAdaptersForFeatures(flags))).toContain("iracing");
    expect(ids(serverGameAdaptersForFeatures(flags))).toContain("iracing");
  });

  test("omits iRacing from production registries while keeping F1", () => {
    const flags = releaseFeatureFlags(false);
    expect(ids(gameAdaptersForFeatures(flags))).not.toContain("iracing");
    expect(ids(serverGameAdaptersForFeatures(flags))).not.toContain("iracing");
    expect(ids(gameAdaptersForFeatures(flags))).toContain("f1-2025");
    expect(ids(serverGameAdaptersForFeatures(flags))).toContain("f1-2025");
  });
});
```

- [ ] **Step 2: Run test and verify missing-export failures**

Run: `bun test test/release-game-registration.test.ts`

Expected: FAIL because adapter-selection functions do not exist.

- [ ] **Step 3: Implement adapter selection and initialization**

In `shared/games/init.ts`, export `gameAdaptersForFeatures(flags = releaseFeatureFlags(true))` returning Forza, F1, ACC, AC Evo, plus iRacing only when `flags.iracingAdapter`; make `initGameAdapters(flags = releaseFeatureFlags(true))` register that returned list.

In `server/games/init.ts`, export `serverGameAdaptersForFeatures(flags = releaseFeatureFlags(true))` preserving F1-first ordering and omitting iRacing when disabled; make `initServerGameAdapters(flags = releaseFeatureFlags(true))` register exactly that list into both registries.

- [ ] **Step 4: Bind client and server environments**

Create `client/src/lib/release-features.ts`:

```ts
import { releaseFeatureFlags } from "@shared/release-feature-flags";
import { isDevelopment } from "./env";

export const clientReleaseFeatures = releaseFeatureFlags(isDevelopment);
```

In `client/src/main.tsx`, pass `clientReleaseFeatures` to `initGameAdapters`.

In `server/index.ts`, resolve once from `IS_DEV` and pass the same object to both initializers:

```ts
const releaseFeatures = releaseFeatureFlags(IS_DEV);
initGameAdapters(releaseFeatures);
initServerGameAdapters(releaseFeatures);
```

- [ ] **Step 5: Run focused tests**

Run: `bun test test/release-feature-flags.test.ts test/release-game-registration.test.ts`

Expected: 4 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add shared/games/init.ts server/games/init.ts client/src/lib/release-features.ts client/src/main.tsx server/index.ts test/release-game-registration.test.ts
git commit -m "feat: gate iRacing adapter registration"
```

---

### Task 3: F1 Route and iRacing Detection Gates

**Files:**
- Modify: `client/src/lib/game-routes.ts`
- Modify: `client/src/lib/release-features.ts`
- Modify: `server/games/init.ts`
- Modify: `server/index.ts`
- Modify: `test/client-game-routes.test.ts`
- Modify: `test/release-game-registration.test.ts`

**Interfaces:**
- Consumes: resolved `ReleaseFeatureFlags` from Tasks 1-2 and `clientReleaseFeatures` for production UI defaults.
- Produces: `supportsGameFeature(prefix, feature, flags = clientReleaseFeatures)`, `setupEngineerGameIdForRoutePrefix(prefix, flags = clientReleaseFeatures)`, and `nativeTelemetryGameIds(flags = releaseFeatureFlags(true))`.

- [ ] **Step 1: Extend failing route and detection contracts**

Update `test/client-game-routes.test.ts` to assert:

```ts
const development = releaseFeatureFlags(true);
const production = releaseFeatureFlags(false);
expect(supportsGameFeature("f125", "experiments", development)).toBe(true);
expect(supportsGameFeature("f125", "experiments", production)).toBe(false);
expect(setupEngineerGameIdForRoutePrefix("f125", development)).toBe("f1-2025");
expect(setupEngineerGameIdForRoutePrefix("f125", production)).toBeUndefined();
expect(supportsGameFeature("acc", "experiments", production)).toBe(true);
expect(supportsGameFeature("ac-evo", "experiments", production)).toBe(true);
```

Extend `test/release-game-registration.test.ts`:

```ts
expect(nativeTelemetryGameIds(releaseFeatureFlags(true))).toEqual(["acc", "ac-evo", "iracing"]);
expect(nativeTelemetryGameIds(releaseFeatureFlags(false))).toEqual(["acc", "ac-evo"]);
```

- [ ] **Step 2: Run tests and verify new signatures/exports fail**

Run: `bun test test/client-game-routes.test.ts test/release-game-registration.test.ts`

Expected: FAIL because route helpers do not accept flags and `nativeTelemetryGameIds` does not exist.

- [ ] **Step 3: Gate F1 Experiments in route policy**

Keep `f125` in `ROUTE_FEATURES.experiments`. Add a special release-policy check before the matrix result:

```ts
if (prefix === "f125" && feature === "experiments" && !flags.f1Experiments) return false;
```

Pass `flags` through `setupEngineerGameIdForRoutePrefix` to `supportsGameFeature`. Both route helpers default to `clientReleaseFeatures`; tests pass explicit development/production flags.

- [ ] **Step 4: Gate native iRacing supervision**

Export from `server/games/init.ts`:

```ts
export function nativeTelemetryGameIds(flags = releaseFeatureFlags(true)): readonly ["acc", "ac-evo"] | readonly ["acc", "ac-evo", "iracing"] {
  return flags.iracingAdapter ? ["acc", "ac-evo", "iracing"] : ["acc", "ac-evo"];
}
```

In `server/index.ts`, use this list for the supervisor log and wrap the existing iRacing `superviseSource(...)` call in `if (releaseFeatures.iracingAdapter)`. ACC and AC Evo calls stay unconditional.

- [ ] **Step 5: Run focused tests**

Run: `bun test test/release-feature-flags.test.ts test/release-game-registration.test.ts test/client-game-routes.test.ts`

Expected: all focused tests pass.

- [ ] **Step 6: Run production builds**

Run:

```bash
cd client && bun run build
cd .. && bun run build
```

Expected: client TypeScript/Vite build and server production compilation complete successfully.

- [ ] **Step 7: Smoke-check production and development UI**

Production preview:

1. F1 25 remains selectable; Experiments link is absent; direct `/f125/experiments` is rejected.
2. iRacing is absent from game selector and Games settings.
3. ACC still exposes Experiments.

Development:

1. F1 25 shows Experiments.
2. iRacing appears in game selector and Games settings.

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/game-routes.ts server/games/init.ts server/index.ts test/client-game-routes.test.ts test/release-game-registration.test.ts
git commit -m "feat: apply production release gates"
```
