---
status: proposed
---
# Shared telemetry processing ownership

Sparse-capture parsing/indexing, sector computation, and concrete lap detection are shared domain behavior, not backend persistence or acquisition policy. `@raceiq/telemetry-core` owns portable algorithms and contracts; `@raceiq/telemetry-processor` composes them into batch processing and explicit routing to game-owned parsers. RaceIQ live/import/replay and independent Bun batch processing reuse one implementation; hosts retain I/O, lifecycle effects, and persistence. Keep dependencies acyclic: the processor may depend on telemetry-core and game packages, while game packages and backend-core must not depend on the processor.

This keeps complete-payload cloud processing independent of server boot while preserving incremental RaceIQ paths and current game-specific timing/detection semantics. Runtime metadata must be packaged from authoritative catalogs, not filesystem-loaded or duplicated by hand. Reusing the existing lower-level telemetry-core package breaks the game-adapter/backend dependency cycle without adding a package, runtime layer, or adapter abstraction.

Relocation must preserve rejection assertions and caller-controlled test environments. Portable constructors use erasable TypeScript syntax; obsolete host-detector declarations are removed rather than suppressing compiler checks.

Plan: [Approved implementation scope and acceptance](../plans/reusable-lap-processor.md)
