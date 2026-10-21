# Catalogue UI extraction implementation plan

Authority: [shared catalogue contract](catalogues-contract.md); counterpart: [server plan](catalogues-server-plan.md). Reuse the [feature pattern](../docs/architecture/feature-packages.md). Dashboard remains untouched.

ADR: [Feature-owned E2E boundaries](../docs/adr/0015-e2e-aware-package-extraction.md).

## Ownership and tasks

1. Cars implementer owns `packages/cars-catalogue/ui/`, its UI contracts, existing `client/src/components/cars/`, `AcEvoCars.tsx`, `AccCars.tsx`, F1 cars directory, `IRacingCars.tsx`, `LMUCars.tsx`, and a new feature-specific host adapter under `client/src/features/`. Tracks implementer owns `packages/tracks-catalogue/ui/`, its UI contracts, existing `TrackViewer.tsx`, complete `components/track/` catalogue UI and its own host adapter. Query existing symbol references with LSP before exported moves; migrate all consumers without shims.
2. Export existing feature component names through each public `./ui` entry. Inject typed host bindings for existing shared controls, translated messages/runtime, authenticated Hono client calls/query hooks, navigation/game/units/settings and shared rendering. UI/contracts must not import app implementation or server code. Do not copy shared controls/translations, normalize game DTOs, or add unsafe casts to bypass typing.
3. Move exclusively owned types/helpers into feature contracts/UI; parent integration editor updates genuinely shared hook and root route callers. Declare actual third-party/shared dependencies. Keep static imports and existing behavior/layout/strings.
4. Move the existing feature browser specs into each `test/e2e/`, preserving assertions and explicit shared harness imports. Integration editor updates Playwright discovery/server setup once after both features settle. Do not leave central spec copies.
5. Add scoped UI TypeScript configuration and import-boundary coverage via the shared integration owner. Feature UI/server development proceeds independently inside disjoint package directories after the shared contract is fixed. Host adapters remain real production integrations; no fixtures/mocks as production fallbacks.

## Acceptance and edge handling

Owned CAT-01/02/03/04/06; shared CAT-05/07/08. Exact meanings and setup/action/results are in the [contract](catalogues-contract.md#acceptance-criteria). Preserve all six games, empty/no-match/reset, nullable/missing specs/assets, game context, route redirects, supported detail tabs and cross-feature compare/back navigation. Existing feature capability distinctions are maintained, not flattened.

Map tasks 1–4 to CAT-E01/E03/E05/E08; boundary configuration to CAT-E06; integration selection to CAT-E07. UI can use contract-conforming local fixtures while development proceeds, but completion requires real compiled UI/server/DB integration for every applicable scenario. Integration owner executes the shared matrix after both implementers finish; no claim of completion from typecheck or a worker report alone.

## Verification after edits settle

Coordinator runs explicit feature UI typechecks, `bun run typecheck`, `bun run lint`, `bun run test:shards`, production `bun run build`, actual relocated feature Playwright suites through the shared harness, and CAT-E01–08. Before/after real discovery must preserve test identities without duplicate ownership. Use page-only visual smoke for both surfaces with existing typed fixture/data conventions; no desktop control.

Workers skip tests/builds/lint/formatters, delegation, staging and commits. They return exact changed paths, exported UI/provider/host binding names, required integration changes, blockers and unverified gates. Coordinator owns final verification and documentation. No checkpoints, per user choice.

## Completion

Implemented and integrated. Both feature packages own their UI and browser-safe contracts; the client retains real typed host adapters and composes their providers. Callers use public entries, existing controls/translations remain shared, and the PI helper has one implementation in `@raceiq/frontend-pure/pi-class`.

Owned and shared acceptance criteria passed the real integration scenarios recorded in [contract verification outcomes](catalogues-contract.md#verification-outcomes), including all six car games, track navigation/capability flows, desktop/mobile visual inspection, import boundaries and exact test ownership. Final UI/server integration is complete, not inferred from isolated fixtures or typechecks. Task paths above describe the pre-extraction relocation sources.
