# Bun recorder performance extraction

ADR: [Decision](../adr/0009-bun-recorder-performance.md).

## Requirements
Extract only decoded-packet fingerprint removal and reusable Bun benchmark tooling from the halted Rust migration into a new branch and pull request based on main. Preserve the migration branch and its uncommitted changes. Do not include Rust implementation, transport changes, native build requirements, or F1 grid caching.
Keep Mitata as the parser/pipeline throughput benchmark engine. Custom subprocess samplers and end-to-end acquisition/import/finalization scenario timers remain separate from throughput microbenchmarks.

## Implementation
1. Retain fingerprint-removal contracts and caller updates; raw capture hashing, accumulation, partial-stream fallback, derived results and processing versions remain unchanged.
2. Extract Bun-only stage parsing/processing and isolated retained-heap profiling, plus complete import/recording benchmark tooling. Adapt to main APIs, remove native selection/transport and native clock dependencies, keep workload identity, outcome validation and explicit measurement boundaries. Route lap setup persistence through the existing database adapter so null benchmark adapters do not execute SQLite writes.
   In-memory import trials use the production lap-index parser/detector with captured outcomes; persistent file-import trials exercise the actual import API. Keep persistence, reconciliation and history seeding excluded from the in-memory scope rather than adding production-only injection APIs for benchmarking.
   Run stage throughput through the existing Mitata harness with prepared-state/computed-argument setup outside measured operations; preserve full snapshots, bounded processing, accepted/source counts and distinct memory windows.
3. Document commands and limitations; update Unreleased notes. Exercise actual stage/memory/import/recording paths and affected reconciliation tests. Verify types and provenance, then commit, push and open PR against main.

## Acceptance
No Rust dependencies or migration behavior in PR. Bun benchmarks run on main fixtures and expose raw timing/resource data with explicit scopes. Reconciliation retains raw source identity and result/fallback semantics without decoded fingerprint. Verification and PR describe measured consumer-only improvement without claiming end-to-end speedup.
