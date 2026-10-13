---
status: proposed
---
# Keep dashboard analytics in SQLite with trigger-invalidated summaries

## Context

RaceIQ stores session/lap metadata in SQLite (`app.db`) and raw telemetry in capture files. Main and per-game historical dashboards share a capped 200-lap list, unlimited session listing, per-session query fanout, and capture-derived work during reads. Those paths do not establish correctness or readiness for a large recording database.

The dashboard must include only sessions explicitly owned as `mine`, including recent/latest selection and historical best comparisons. Recording and persisted timestamps remain UTC. Existing browser-local calendar grouping is a presentation boundary expressed as UTC query instants, not a source timestamp rewrite.

## Proposed decision

Keep the existing Bun/libSQL connection, Drizzle schema reference, and embedded SQLite migration system. Add normal persisted summary tables inside the same `app.db`; they provide materialized-view behavior without requiring native materialized views or another database engine.

Use lightweight SQLite triggers to increment source revisions and persist dirty state for relevant lap/session/result/pit mutations. Triggers do not aggregate history, decode captures, or publish summaries. Direct SQL and helper-driven writes share the same integrity boundary. Recording-file-only changes and processor-version upgrades require explicit application invalidation because SQL triggers cannot observe file bytes.

Use a bounded Bun processor for metadata rebuilding, capture-derived facts and resumable backfill. Publish old-versus-new contributions atomically only when the observed source revision is still current. Retain deleted-session tombstones and previous contributions until subtraction completes; source FK cascades must not erase that evidence prematurely.

Read endpoints use bounded, indexed aggregates and exact dirty-source reconciliation in a consistent short SQLite snapshot. They do not process or stat recordings. Ownership filtering applies before ranking, aggregation and limits; cached others/deleted contributions cannot remain visible while cleanup is pending. Preserve all source rows and recordings; derived tables are rebuildable.

No Effect npm dependency or dashboard DuckDB store is introduced.

## Rationale and alternatives

SQLite summaries address the actual correctness/read-amplification problems while keeping source mutation and invalidation transactional in one database. WAL and bounded transactions support concurrent recording, subject to measured single-writer contention gates.

DuckDB offers stronger columnar/ad-hoc analytical queries but an analytics copy adds synchronization, freshness lag and a second deletion/ownership consistency boundary. Reconsider it for large telemetry-sample analytical workloads or measured SQLite query limitations, not as a substitute for fixing capped inputs and recording work on GET.

Application-only invalidation is easier initially but misses direct SQL/import/reprocessing paths unless every caller remains disciplined. Small persisted triggers protect those paths. Heavy aggregate-maintenance triggers are rejected because they put computation into the source-write critical path. Effect does not supply a needed capability beyond the existing runtime/transaction lifecycle for this bounded processor.

UTC daily rollups cannot by themselves exactly reproduce browser-local daily charts; sparse UTC time-bucket contributions plus exact partial-bin facts preserve those calendar semantics without changing UTC storage. This grain adds write/storage overhead and must pass the plan's scale gates.

## Consequences and acceptance

Additional derived schema, migrations, trigger coverage, versioned processing and backfill operations must be maintained. SQL triggers do not remove the need for capture finalization hooks, client refresh events or concurrency tests. The proposal is accepted for implementation only after maintainer approval; neither this document nor the plan claims performance targets have already passed.

Plan: [Implementation phases and success criteria](../../advisor-plans/001-sqlite-dashboard-read-model.md).
