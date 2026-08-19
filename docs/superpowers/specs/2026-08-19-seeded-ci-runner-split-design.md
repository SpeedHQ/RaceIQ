# Seeded CI Runner Split

## Goal

Reduce seeded Playwright E2E wall time without introducing shared-state races.

## Current state

The seeded CI matrix runs 175 tests in one reusable workflow job:

- `seeded-e2e`: 84 tests
- `seeded-routes`: 75 tests
- `seeded-imports`: 12 tests
- `mobile-device` and `tablet-device`: 4 tests

Each job uses `PW_WORKERS=1` because seeded tests share server-side SQLite, telemetry, and replay state.

## Design

Replace one seeded matrix entry with three entries. Every entry invokes the existing reusable Playwright workflow, gets its own runner and server/database, and keeps `PW_WORKERS=1`.

### seeded-analyse-live

42 tests:

- `seeded/analyse/**/*.spec.ts`
- `seeded/compare/**/*.spec.ts`
- `seeded/dash/**/*.spec.ts`
- `seeded/landing/**/*.spec.ts`
- `seeded/live/**/*.spec.ts`

### seeded-app-domains

46 tests:

- `seeded/catalog/**/*.spec.ts`
- `seeded/chats/**/*.spec.ts`
- `seeded/dev-tools/**/*.spec.ts`
- `seeded/driver/**/*.spec.ts`
- `seeded/experiments/**/*.spec.ts`
- `seeded/raw/**/*.spec.ts`
- `seeded/sessions/**/*.spec.ts`
- `seeded/settings/**/*.spec.ts`
- `seeded/setups/**/*.spec.ts`

### seeded-routes-imports-devices

91 tests:

- `seeded-routes`
- `seeded-imports`
- `mobile-device`
- `tablet-device`

Routes are numerous but lightweight health checks. Keeping them with imports and device checks avoids adding a fourth runner while preserving isolation for stateful domain tests.

## Workflow changes

Apply same three-entry seeded matrix to PR and release callers. Use unique matrix names for test-result and server-diagnostic artifacts. Keep fresh, tunes, and tunes-unseeded entries unchanged. Reusable workflow interface remains unchanged.

## Verification

- Playwright discovery must report expected project/test counts for each matrix entry.
- Workflow YAML must parse.
- Existing CI worker setting remains `PW_WORKERS=1`.
- No project is selected by more than one seeded matrix entry.
