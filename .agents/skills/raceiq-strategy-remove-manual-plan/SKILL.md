---
name: raceiq-strategy-remove-manual-plan
description: Use when removing manual RaceIQ race-plan creation while preserving generated strategy flow and searchable Track/Car selectors.
---

# Remove manual RaceIQ strategy-plan creation

Use for changes that remove the standalone/manual New plan workflow while keeping generated strategy creation and saved-plan management.

## Workflow
- Trace `RaceStrategiesPage` and `RaceStrategyPlanner`: remove all manual blank-plan entry paths, clone-only entry points, and obsolete messages. Preserve generated create/save, opening/editing saved plans, and existing recalc/load/delete behavior.
- Track/Car generator options already come from host catalog hooks; prefer injecting the shared client `SearchSelect` through `RaceStrategyHost`, not adding a package-specific select implementation.
- Update `packages/race-strategy/test/e2e/race-plan.spec.ts` to use portal `page.getByRole("option")` for SearchSelect. Assert selected values, evidence state, and generate/save behavior. `SearchSelect` menu options render in a portal, not under generator DOM scope.
- Remove obsolete manual/clone workflows from dependent strategy E2E tests, retaining tests for generated plans and existing-plan management.
- Remove dead locale message keys from all `client/messages/*.json` locales and update `packages/race-strategy/contracts/messages.ts`. Run `bun run build` to validate Paraglide JSON and generated message types; the locale key hook also checks exact key parity.
- Run focused E2E: from `packages/race-strategy`, `bun run test:e2e -- --grep "G0|G1 Strategies page"`. G1-G2/L1 also exercises searchable selectors and generation, but includes additional session-deletion evidence-refresh assertions; report those failures separately rather than weakening them.
- Update `CHANGELOG.md`.
