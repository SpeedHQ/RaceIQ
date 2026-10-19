# Working with Effect

Read this guide before adding, changing, debugging, or reviewing Effect-based code in RaceIQ.

## Required references

Use [Effect Solutions](https://www.effect.solutions/quick-start) as the primary practical guidance for Effect patterns. Read the topics relevant to the task before implementation; do not load every topic for a localized change.

Use the [official Effect documentation](https://effect.website) and version-matched upstream API documentation or source to resolve API details. Effect Solutions is guidance, not a substitute for checking the version RaceIQ actually uses.

## Version and setup

- Target **Effect v4**, not v3 examples. Check the owning package manifest and lockfile before choosing an API.
- The Online workspace currently pins `effect` and `@effect/sql-sqlite-bun` to `4.0.4` in [packages/online/package.json](../../packages/online/package.json). Keep their versions aligned; do not upgrade dependencies as an incidental part of a bug fix.
- Verify unfamiliar option names, signatures, interruption behavior, and persistence semantics against version-matched upstream references. Do not inspect installed `node_modules/` source; follow the repository's dependency-inspection rules.
- Quick-start recommendations such as installing the Effect Language Service, installing a global CLI, or cloning upstream are optional setup changes, not prerequisites for every task. Do not make unrelated tooling or configuration changes automatically.

## Implementation conventions

- Reuse the existing subsystem's services, layers, schemas, and boundaries. Do not introduce a parallel implementation or convert unrelated Promise-based code merely because Effect is available.
- Compose effects with `Effect.gen` or pipelines. Run effects at application, worker, or test boundaries rather than scattering nested runtime calls through domain logic.
- Wrap external Promise operations with `Effect.tryPromise`; map expected failures into explicit domain errors. Use v4 tagged errors when a recoverable error belongs in the typed error channel. Keep defects distinct from expected failures.
- Use scoped resources and finalizers for lifecycle management. Preserve interruption; do not swallow cancellation in broad error handlers. Keep uninterruptible regions limited to operations that must finish atomically or persist a truthful receipt.
- Prefer Effect's queues, fibers, schedules, and persistence facilities over bespoke concurrency, retry, lease, or timer machinery. Keep retries bounded in rate and consistent with the domain's failure semantics.

## Durable work and retries

RaceIQ Online uses `Effect PersistedQueue` for delivery and a separate outbox ledger for account ownership, upload identity, and outcomes. Preserve that ownership split.

- Let the package own queue storage, locks, heartbeats, and scheduling. Do not manipulate package-owned tables in production to work around an undocumented API.
- Keep credentials and authorization checks out of durable queue messages. Recheck current account, consent, privacy, and setup preferences before transport starts.
- Distinguish definite no-send failures from ambiguous acceptance. A retry budget must not turn an uncertain transfer into a false rejection or permanently strand its reconciliation.
- Preserve the same idempotency key while reconciling uncertain acceptance. Known acceptance must prevent another transfer; acceptance is not remote validation or publication.
- Treat package delivery attempts, business retry budgets, active-work capacity, and retained history as separate concepts. Changes must also account for previously persisted work.

## Verification

- Exercise the real changed Effect runtime path, not only helpers or mocked forwarding. Use isolated temporary storage for persistence scenarios.
- Cover relevant failure transitions: interruption, restart, retry exhaustion, ambiguous outcomes, duplicate delivery, account changes, and graceful shutdown. Do not add unrelated scenarios to a small change.
- Run focused behavioral regressions and `bun run typecheck`. Reuse successful verification only while its relevant inputs remain unchanged.
- Report the exercised scenarios and any limits explicitly; local queue verification does not establish authenticated remote upload behavior.

For the current Online implementation and remaining recording-integration gates, see [upload recovery progress](../plans/raceiq-online-progress.md).
