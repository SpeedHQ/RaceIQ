---
status: accepted
---
# Keep startup-worker SQL transactions in parent-owned native handles


Related decision: [SQLite dashboard read model](0010-sqlite-dashboard-read-model.md).

## Context

Startup reconciliation and dashboard publication run in a Bun worker while HTTP imports, deletion, recording, and maintenance also mutate SQLite. One backend-owned write authority must cover each complete write unit across those contexts.

On Bun 1.4.3, terminating a worker with an active native libSQL transaction left the SQLite write lock held after the worker exit event and the resolved termination promise. The real application crash scenario then returned `SQLITE_BUSY` for queued HTTP deletion. Closing worker clients and synchronous worker exit hooks did not reliably release the transaction connection.

## Decision

The user selected parent-owned transactions. Keep parsing, reconciliation, and dashboard processing in the existing worker, but execute its writer SQL through typed, lease-bound RPC on parent-owned native libSQL handles. Preserve the installed database engine, Effect 4.0.4 pins, schema, and HTTP/UI contracts.

The parent owns native transactions, validates lease/transaction ownership, and serializes operations within each lease. Live operation promises and monotonic identifiers prevent duplicate execution without a completed-operation ledger. Worker read queries use a separate native query-only connection and do not acquire write admission.

After worker exit, stop admission, await submitted native operations, roll back and close remaining transactions, then release the shared permit. Normal lease release is acknowledged only after native cleanup and physical permit release; publication notifications await that acknowledgement. Closing the worker SQL host never closes the shared parent client. Ordinary shutdown drains owners instead of force-terminating the worker.

## Rationale and consequences

Parent-owned handles remain reachable after worker failure, so native cleanup no longer depends on the terminated worker executing JavaScript finalizers. The application crash scenario must prove rollback, preservation of the previous committed projection, and successful queued HTTP deletion through the production backend.

RPC adds transport and result-codec overhead to worker SQL, while capture decoding and file work remain outside the permit and off the parent thread. Result rows, BLOBs, bigints, error metadata, and transaction semantics require native transport regression coverage.

A second permit authority, SQL-text admission classification, busy retries, increased timeouts, and transaction exit-hook wrappers are rejected. Switching the worker to Bun SQLite was considered but not selected; it would introduce a separate driver compatibility boundary rather than preserving the current native client.
