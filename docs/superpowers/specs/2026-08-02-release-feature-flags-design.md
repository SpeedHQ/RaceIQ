# Release Feature Flags

## Goal

Keep unfinished F1 Experiments and iRacing integration available during development while disabling both from production releases.

## Feature Policy

One committed root environment-file pair is the source of truth for client and server:

`.env.development`:

```dotenv
RACEIQ_FEATURE_F1_EXPERIMENTS=true
RACEIQ_FEATURE_IRACING_ADAPTER=true
```

`.env.production`:

```dotenv
RACEIQ_FEATURE_F1_EXPERIMENTS=false
RACEIQ_FEATURE_IRACING_ADAPTER=false
```

The shared feature policy parses these explicit string values into two flags:

- `f1Experiments`
- `iracingAdapter`

It does not infer feature state from `import.meta.env.DEV`, `NODE_ENV`, or any other environment classification. The same named values control browser routes, shared/server adapter registration, and native-source supervision.

## F1 Experiments

F1 remains a registered game in every environment. Only its Experiments feature changes:

- Development: F1 Experiments navigation and routes remain enabled.
- Production: sidebar omits F1 Experiments and experiment parent/child routes reject F1 through existing unsupported-route handling.
- F1 Driver, Sessions, Analyse, Setups, Raw Data, telemetry detection, and every other F1 surface remain unchanged.

`client/src/lib/game-routes.ts` consumes the resolved `f1Experiments` flag when answering `supportsGameFeature("f125", "experiments")`. ACC and AC Evo Experiments remain enabled in every environment.

## iRacing Adapter

Development keeps current iRacing behavior unchanged.

Production disables iRacing at registration and detection boundaries:

- Shared game initialization omits `iracingAdapter`; client game selector, settings, and generic game routes therefore have no registered iRacing game to expose.
- Server game initialization omits `iracingServerAdapter` from both server and shared registries.
- Windows native-source supervision omits the iRacing `isGameRunning` check and `IRacingTelemetrySource` startup path.
- ACC and AC Evo native-source supervision remains unchanged.

Existing iRacing implementation and import tooling remain in source for development and future release. This change does not require dynamic imports or removal from the compiled bundle; it prevents runtime registration, UI exposure, and process detection.

## Interfaces

A shared strict resolver returns immutable flags from an explicit environment-shaped input:

```ts
export interface ReleaseFeatureFlags {
  readonly f1Experiments: boolean;
  readonly iracingAdapter: boolean;
}

export interface ReleaseFeatureFlagEnvironment {
  readonly RACEIQ_FEATURE_F1_EXPERIMENTS: string | undefined;
  readonly RACEIQ_FEATURE_IRACING_ADAPTER: string | undefined;
}

export function releaseFeatureFlags(env: ReleaseFeatureFlagEnvironment): ReleaseFeatureFlags;
```

Only exact `true` and `false` strings are accepted. Client startup passes the two `import.meta.env.RACEIQ_*` values. Shared browser defaults read the same `import.meta.env` values. Server startup passes the corresponding `process.env` values. Focused tests pass explicit parsed flags; the test preload populates Bun's environment from `.env.development`. Direct Bun tools pass a shared development flag object parsed from that committed file instead of depending on the caller's shell environment.

Vite and Storybook use the repository root as `envDir` and expose the `RACEIQ_` prefix. Development commands explicitly load `.env.development`. The production build explicitly loads `.env.production`, and `scripts/build.ts` passes both values to Bun `--define` arguments so the compiled server contains the same production flags as the client bundle without requiring external env files at runtime.

`gameAdaptersForFeatures(flags)` and `serverGameAdaptersForFeatures(flags)` return the exact adapter lists registered by `initGameAdapters(flags)` and `initServerGameAdapters(flags)`. Client routes consume the client-bound flags. Windows supervision uses `nativeTelemetryGameIds(flags)` and conditionally calls the iRacing supervisor only when `iracingAdapter` is enabled.

## Error Handling

- Missing or malformed feature values fail immediately with an error naming the invalid variable.
- Build and startup never silently infer defaults from development or production mode.
- Direct production F1 experiment URLs use existing unsupported-route behavior.
- Direct production iRacing routes fail existing unknown/unsupported game handling because iRacing is absent from the shared registry.
- No new redirect, notice, or fallback is introduced.

## Verification

Automated contracts prove:

- The committed development env file parses both flags as true.
- The committed production env file parses both flags as false.
- Missing, empty, and non-boolean values fail with the variable name.
- Development F1 Experiments remain supported; production F1 Experiments are unsupported.
- ACC and AC Evo Experiments remain supported in both environments.
- Development adapter initialization registers iRacing.
- Production shared/server initialization does not register iRacing or its process names.
- Production supervisor configuration contains ACC and AC Evo but not iRacing.

Run focused env-parser, route-helper, adapter-registration, and changelog tests. Run client and server production builds. Browser-smoke the production client: F1 remains selectable without Experiments; iRacing is absent; ACC still exposes Experiments. Development smoke confirms both F1 Experiments and iRacing remain visible and usable.

## Non-goals

- Designing F1 experiment setup sourcing.
- Removing iRacing source, parser, import, database, or test code.
- Excluding iRacing modules from release artifact bytes.
- Adding user-configurable or remote feature flags.
