# Race Engineer backend naming plan

Boundary and acceptance: [shared contract](race-engineer-naming-contract.md). UI proceeds independently via [UI plan](race-engineer-naming-ui-plan.md).

## Scope and ownership

Code rename owner owns server, shared, telemetry/tooling packages, code consumers, tests, package exports and test manifests. Preserve generated audio and damage behavior. Documentation owner updates prose and internal path references without falsifying upstream attribution. Main assistant owns shared contract and integration execution.

## Tasks

1. Use language-server references and rename for exported identifiers, including declarations in shared contracts and trigger catalog; migrate all consumers (N1/N4).
2. Rename source/test files and directory contents using language-server file rename; update package exports and suite manifests. No compatibility aliases (N1/N4).
3. Cut over computed replay IDs, rendering discriminator, subsystem key and coverage evidence names as specified by shared contract (N1/N3).
4. Update documentation and tests, preserving detector state, ordering, gates, source validation and audio segment IDs (N1/N2).

## Verification

Execute shared E1 on actual catalog/voice engine entry points; reuse damage integration suite and production browser audio player with generated assets. Execute E2 replay and WebSocket suites to prove renamed producer and parser integration. Execute E3 targeted diagnostics, package imports and test manifests. N2 edge cases map to E1; coordinated restart and no legacy discriminator acceptance map to E2. Record all outcomes; known Windows directory-fsync failure is not renamed-path evidence. Completion requires main integration owner to finish E1–E3, including real UI/backend verification.
