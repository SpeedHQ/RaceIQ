# Lap replay UI implementation

Contract: [shared integration contract](lap-replay-contract.md). Reciprocal server work: [server plan](lap-replay-backend-plan.md).

## Scope and ownership

Own the existing `client/src/components/comparison/spectate/` implementation, shared `InsightPanel`, replay preparation/controller and line-spread presentation helper, their exclusively owned unit tests and browser E2Es. Move these into `packages/lap-replay/ui/`, `contracts/`, and `test/`; keep application route selection and shared scene/telemetry/AI platform composition in typed client host bindings. Do not move unrelated import/export/session-maintenance or Focus View behavior solely to fill package directories.

## Tasks

1. Establish explicit UI host/provider contracts using the catalogue convention. Bind existing app controls, translations, settings, game context, queries and model resources without reverse client imports. Move authoritative replay types to contracts with the server owner; retain current shared DTO ownership.
2. Move Spectate UI, shared workspace and Insights rendering without copied implementations or old forwarding files. Migrate all direct callers, stories, tests and smoke consumers to public exports. Preserve distinct single-lap and paired AI composition (C1/C2).
3. Move native playback/preparation and focused unit tests. Preserve native clock/progress semantics, sample gaps and unavailable states. Cover invalid/coalesced/tail event indices, B plateaus and missing A coverage with controller tests (C2/C4).
4. Move every exclusively owned Spectate spec and new Replay workspace spec to `test/e2e/`; retain genuinely shared central helpers and exactly one Playwright owner. Update the header scenario for five panels without pinning an obsolete DOM order (C3/C5).

## Acceptance and verification

UI acceptance is C1, C2, C3 and the UI/test part of C5 in the shared contract. Reuse its E2E scenarios and edge handling verbatim: desktop/mobile single replay, A/B native event seeks, panel/keyboard transitions, paired playback/Data and existing unavailable/retry behavior. Run against the complete application and real backend; fixtures/mocks do not replace final integration.

The coordinator executes those scenarios after integration, records outcomes, checks browser-safe imports through scoped TypeScript and boundary gates, and runs the production browser build. Source/config/fixture changes invalidate affected previous evidence. UI and server can implement independently against the agreed contract; only final integration depends on both.

## Implementation outcome

The package owns both panel configurations, shared workspace/Insights UI, the complete paired scene/controller implementation, browser-safe contracts and all 11 feature browser specs. The application supplies existing scene, telemetry, single-lap AI and comparison AI primitives through typed composition and host bindings. Package tests retain the shared harness's CommonJS execution mode without adding another workspace.

Executed outcomes, screenshots, input-boundary coverage and the existing zoom retry are recorded once in the [shared verification record](lap-replay-contract.md#recorded-verification). Both desktop/mobile Replay and A/B recorded-event scenarios passed against the compiled real application. Rare controller-input cases have unit evidence rather than individually forced browser fixtures.
