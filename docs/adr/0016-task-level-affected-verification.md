---
status: proposed
---
# Select affected verification tasks before provisioning CI

## Context

RaceIQ uses Turbo 2.11.7 task-input-aware selection and feature-owned E2E impact tasks. Ordinary local wrapper calls nevertheless fall back to full selection when explicit SCM variables are absent. Shared domain input lists broaden unrelated suite invalidation. Browser and visual workflows provision their full matrices regardless of affected ownership.

The existing feature-package contract requires conservative coverage for unknown impact, real compiled-application E2Es, and separation of impact from build prerequisites. Previous manual verification requirements retain full execution for unusable or equal explicit ranges.

## Proposed decision

1. Preserve Turbo-native comparison for ordinary local calls without explicit SCM overrides. Preserve full manual/default verification and conservative fallback for untrustworthy ranges.
2. Scope suite inputs to real production, test, fixture, runner, configuration, and dependency consumers. Keep transitive propagation and environment-sensitive cache invalidation; do not hide genuine graph edges.
3. Restore the base CI dependency graph and existing shard layout. Run existing verification steps and shards through Turbo tasks with affected selection rather than a separate dynamic matrix-selection graph.
4. Skip task commands only when a trustworthy affected comparison proves them unaffected. Invalid ranges, incomplete ownership, and selection failures execute full verification with a diagnostic.
5. Preserve full entry points, test inventory, seeded and hardware prerequisites, required status behavior, and uncached browser and build results. Verify selected, unaffected, fallback, failure, and hosted execution paths before claiming completion.

## Rationale and consequences

The package/task graph remains the source of impact truth rather than a second file-to-test mapping. Task selection and caching solve different costs. Shared build prerequisites must not make every feature affected, but genuinely shared auth, schema, composition, harness, and runtime changes retain broad coverage.

This does not authorize package extraction, product changes, test deletion, remote-cache setup, toolchain upgrades, or weaker verification. Residual legacy suites may remain broad where actual dependencies require it. Full selection remains the safe response to unavailable history, not an optimization failure to suppress.

## References

- Plan: [Precise Turbo affected verification](../superpowers/plans/2026-11-03-turbo-affected-verification.md).
- Existing contract: [Feature package tests and Turbo selection](../architecture/feature-packages.md#tests-and-turbo-selection).
- Related decision: [Feature-owned E2E boundaries](0015-e2e-aware-package-extraction.md).
- Official guidance: [Constructing CI](https://turborepo.com/docs/crafting-your-repository/constructing-ci), [Configuring tasks](https://turborepo.com/docs/crafting-your-repository/configuring-tasks), [Affected query](https://turborepo.com/docs/reference/query#affected).

Planning only. Proposed status does not imply implementation approval or passing verification.
