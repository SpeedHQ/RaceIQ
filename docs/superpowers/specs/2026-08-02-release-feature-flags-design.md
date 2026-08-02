# Release Feature Flags

## Goal

Keep unfinished F1 Experiments and iRacing integration available during development while disabling both from production releases.

## Feature Policy

Add one pure shared feature policy with two flags:

- `f1Experiments`: enabled outside production; disabled in production.
- `iracingAdapter`: enabled outside production; disabled in production.

Environment detection stays at runtime boundaries:

- Client supplies `import.meta.env.DEV`.
- Server supplies `process.env.NODE_ENV !== "production"` through existing `IS_DEV`.
- Tests supply an explicit boolean and default adapter initialization to development behavior.

The shared policy contains no direct `import.meta` or `process.env` access, so browser and server consumers use the same rules without cross-runtime globals.

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

A shared pure resolver returns immutable flags from an explicit environment input:

```ts
export interface ReleaseFeatureFlags {
  readonly f1Experiments: boolean;
  readonly iracingAdapter: boolean;
}

export function releaseFeatureFlags(isDevelopment: boolean): ReleaseFeatureFlags;
```

`gameAdaptersForFeatures(flags)` and `serverGameAdaptersForFeatures(flags)` return the exact adapter lists registered by `initGameAdapters(flags)` and `initServerGameAdapters(flags)`. Both initializers default to `releaseFeatureFlags(true)` so existing tests and development tooling retain iRacing unless a caller explicitly supplies production flags.

Client startup resolves flags from `import.meta.env.DEV`; server startup resolves them from `IS_DEV`. `supportsGameFeature(prefix, feature, flags)` receives the resolved flags, with its existing two-argument form defaulting to development flags for test and development compatibility. Windows supervision uses `nativeTelemetryGameIds(flags)` and conditionally calls the iRacing supervisor only when `iracingAdapter` is enabled.

## Error Handling

- Direct production F1 experiment URLs use existing unsupported-route behavior.
- Direct production iRacing routes fail existing unknown/unsupported game handling because iRacing is absent from the shared registry.
- No new redirect, notice, or fallback is introduced.

## Verification

Automated contracts prove:

- Both flags are true for development and false for production.
- Development F1 Experiments remain supported; production F1 Experiments are unsupported.
- ACC and AC Evo Experiments remain supported in both environments.
- Development adapter initialization registers iRacing.
- Production shared/server initialization does not register iRacing or its process names.
- Production supervisor configuration contains ACC and AC Evo but not iRacing.

Run focused feature-policy, route-helper, and adapter-registration tests. Run client production build and server production build. Browser-smoke the production client: F1 remains selectable without Experiments; iRacing is absent; ACC still exposes Experiments. Development smoke confirms both F1 Experiments and iRacing remain visible and usable.

## Non-goals

- Designing F1 experiment setup sourcing.
- Removing iRacing source, parser, import, database, or test code.
- Excluding iRacing modules from release artifact bytes.
- Adding user-configurable or remote feature flags.
