# Race Result Inline Metadata Design

## Goal

Persist derived race-result metadata as part of session processing, version the processor for future reconciliation, and display per-session result fields inline in `SessionsPage` rather than mounting summary cards on unrelated pages.

## Architecture

`RACE_RESULT_PROCESSOR_ID` identifies the derivation contract. Each persisted session result stores that processor version. A centralized post-lap persistence hook reconciles the affected session; reconciliation is idempotent and coalesced per session. Explicit backfill reconciles missing or stale-version rows, while read endpoints remain side-effect free.

`SessionMeta` carries nullable result metadata returned with session rows. `SessionsPage` renders compact result indicators in desktop and mobile session rows. Existing page-top `RaceResultSummary` mounts are removed.

## Requirements

- Add `processor_version` to `session_results` with current processor identifier.
- Reconcile after persisted lap writes through one centralized path.
- Avoid concurrent duplicate reconciliation for one session.
- Reconcile existing rows when stored processor version differs from current version.
- Keep aggregate GET endpoints read-only.
- Return result metadata with session records.
- Render classification, position, podium, fastest-lap, pit count, and pit time inline in session rows.
- Remove Home, Driver Profile, Track Detail, and Cars page-top result summary mounts.
- Preserve explicit backfill support for historical sessions.

## Verification

- Unit tests prove processor-version mismatch triggers recomputation.
- Storage tests prove repeated reconciliation remains idempotent.
- Session query tests prove result metadata is returned inline.
- Client build/typecheck proves row integration and removed mounts compile.
- Targeted race-result tests pass.
