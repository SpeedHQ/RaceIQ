---
status: proposed
---
# Use feature-owned E2E boundaries and selective provisioning

## Context

RaceIQ already has game, metadata, capture, analysis, frontend-pure and tooling workspaces. Browser PR verification nevertheless always schedules a ten-entry matrix and seed preparation. Recording E2Es use affected selection but inherit 148 input patterns and broad backend-core dependencies. More packages alone would not reduce this fanout safely.

## Proposed decision

Extract ONE workspace per feature: top-level `ui/`, `server/` and `contracts/` directories, with feature-owned E2Es under `test/e2e/`. The agreed first extractions are `@raceiq/tracks-catalogue` and `@raceiq/cars-catalogue`; dashboard extraction is deferred. Keep one manifest and application roots as thin composition hosts. Reuse genuinely shared authoritative DTOs rather than copy them into feature-local contracts. The broader CI rollout would add conservative E2E selection before browser provisioning.

Feature E2Es live INSIDE their feature package and run against the complete real compiled application. UI or backend changes intentionally select the feature's E2Es at package granularity. Separate side-effect-free impact selection tasks from build prerequisites: building the full app does not alone make every feature affected. Shared auth, routing/composition, migrations, boot, fixtures and harness inputs still select every actual consumer. Keep app smoke, explicitly owned cross-feature journeys, residual legacy coverage and explicit full execution.

Subsequently isolate game replay from backend AI/persistence/application composition by extracting neutral contracts and processing with host-bound side effects. Retain existing capture/telemetry algorithms and telemetry semantics. Narrow declared dependencies and task inputs only after positive and negative selection scenarios prove complete coverage.

## Rationale and consequences

This prioritizes avoiding unnecessary job provisioning and then makes feature ownership useful to Turbo. Package subpaths and colocated tests alone do not isolate package-level dependencies. Tests that depend on the whole app manifest, shared all-game initialization or every feature's seed/harness implementation will still over-select until those real edges are narrowed.

A single feature package may contain both UI and server code. Require explicit `./ui`, `./server` and `./contracts` exports, no mixed root barrel, scoped TypeScript projects and enforced transitive import boundaries. Production browser build evidence must exclude DB/native/server modules. Separate layer packages are rejected as the default feature-ownership model; package-level invalidation of both halves is intentional. Shared functions used by multiple features may live in an existing suitable package or a new small, purpose-named shared workspace, even when it initially contains one function. Shared packages must not depend on consuming features; their changes select consuming feature E2Es. Arbitrary package proliferation, hidden manifest edges, mock-only integration, suppressed shared inputs and unsafe E2E caching remain rejected.

Dashboard extraction must reconcile active read-model work before moving its files. UI and backend plans proceed in parallel against their shared contract; the integration owner owns discovery, E2E relocation and final integrated validation. Catalogue packages implement the agreed feature topology and inherited Turbo task configuration. The broader selective-CI/replay roadmap remains proposed; implementation of local package selection is not a measured CI speedup claim.

Reusable guidance: [Feature package pattern](../architecture/feature-packages.md), including top-level layout, public entry points, enforced UI/server boundaries, test ownership and adoption checks.

## Plans

- [Shared boundary, acceptance criteria and E2E scenarios](../../advisor-plans/002-e2e-extraction-contract.md)
- [CI selection and feature E2E ownership](../../advisor-plans/003-e2e-selection-plan.md)
- [Backend feature and replay extraction](../../advisor-plans/004-e2e-backend-plan.md)
- [UI feature extraction](../../advisor-plans/005-e2e-ui-plan.md)
- [Ordered change list and landing dependencies](../../advisor-plans/006-feature-extraction-change-list.md)
- [Implemented catalogue extraction contract and verification](../../advisor-plans/catalogues-contract.md)
- [Catalogue UI implementation plan](../../advisor-plans/catalogues-ui-plan.md)
- [Catalogue server implementation plan](../../advisor-plans/catalogues-server-plan.md)
