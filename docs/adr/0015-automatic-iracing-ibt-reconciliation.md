---
status: proposed
---
# Automatically reconcile local iRacing IBTs with live captures

## Context

RaceIQ retains live iRacing SDK capture data, including changing session context and competitor channels. Native IBTs contain additional disk-only geographic channels. The existing opted-in Windows collector already enables native logging, resolves redirected Known Documents, and archives closed IBTs without modifying originals; archiving currently does not attach evidence to existing live sessions. Standalone import would create separate sessions rather than enrich the original capture.

## Decision

Extend the existing collector with unattended historical/new-file inventory and durable reconciliation for existing owned live sessions. Match native segment/player/car/layout identity and exact tick/session-time overlap, never filenames, lap numbers or nearest wall-clock times. Preserve both original sources and stable lap/session identities. Publish supplementary channels only where absent from the live segment dictionary and exact row identity is unambiguous, with explicit IBT provenance and revision-aware replay.

Treat reconciliation revision as a replay-evidence epoch: attachment changes and verified source loss/corruption/restoration each invalidate dependent replay through idempotent durable transitions, even when attachment IDs are unchanged. Full iRacing semantic HTTP replay explicitly serializes supplemental attribution per value/dependency/component; preserve primary provenance and never expose source paths. The shared contract owns wire shapes and null/empty semantics.

Reuse existing capture opt-in, closed-file checks, immutable archival, maintenance ownership and short DB write admission. Do not scan the whole system or import unrelated history. Ambiguous/insufficient evidence stays visibly unresolved. Changed evidence and interrupted work recover automatically; unchanged failures do not spin. Retention and transfer treat both sources as referenced evidence.

Use installed Effect 4.0.4 durable Workflow/Activity APIs with SQL-backed SingleRunner/ClusterWorkflowEngine for reconciliation execution, stage tracking, durable waits and bounded retries. Persist the workflow journal in a dedicated owned SQLite file; validate the compatible SqlClient adapter on Bun/Windows before integration. Do not substitute an in-memory engine, unrelated Cloudflare Durable Objects package or custom persisted queue. Existing recording maintenance is Effect-owned but explicitly non-durable; retain its locking/lifecycle contracts without migrating unrelated jobs.

Execution IDs derive from immutable file generation or session/source/candidate-evidence/baseline/version identity. Record completed activity results and resume the same execution after restart. Domain status is a revision-fenced workflow projection, not independent scheduling state. Durable submission/refresh outboxes and execution-keyed publication receipts bridge journal and application database transactions; replayed side effects must be idempotent. No blanket exactly-once guarantee is claimed. Own the runner in backend scope and await non-cancellable I/O settlement before lease release/shutdown.

Run the reconciler, durable Effect engine and all archive/hash/index/match/fit activities inside one dedicated Bun-hosted `node:worker_threads` Worker, following the existing startup worker's dev/compiled entry pattern. Main backend owns supervision, capture SDK control, admission and native SQL transaction handles; a bounded typed generation-fenced bridge connects worker activities to parent-owned domain/journal SQL hosts. Do not share the startup/dashboard worker, create a worker per recording, or fall back to reconciliation on the main thread. Worker exit/channel loss must settle parent SQL and release leases before one replacement resumes the same durable journal. Verify worker isolation, crash recovery and compiled Windows entry resolution through RE-10.

Measured positions remain geographic-derived scene poses, not native live XYZ. Fit only reference geometry and reject poor/incomplete fits without altering the measured path. Reconciliation does not promise exact live GPS or automatically surveyed track geometry.

Geometry acceptance belongs to a lap/evidence/reference/policy key, not a session-wide flag. Full semantic replay returns the selected lap's result; selection and comparisons cannot inherit another lap's accepted fit. Shared E2E RE-07a and RE-08a verify mixed-lap/mixed-source HTTP presentation and hot-cache loss/restoration respectively.

## Rationale and consequences

A supplementary evidence model preserves live-only data that replacing the capture with IBT would lose. Automatic local discovery meets unattended operation without duplicate sessions or an upload flow. Exact matching sacrifices coverage rather than attach coordinates to the wrong frame. Retaining original IBTs preserves extra native rows even though historical replay remains on the live capture's frame grid. Durable indexes, provenance and source lifecycle changes are required; file archiving alone is insufficient.

Alternative rejected: replace or reimport the live session from IBT, which changes identities and loses live-only context. Nearest-sample merging and reconstructed live GPS are also rejected because they hide uncertainty.

Plans: [Backend implementation](../plans/iracing-ibt-reconciliation-backend-plan.md), [UI implementation](../plans/iracing-ibt-reconciliation-ui-plan.md). Shared policy, acceptance and E2E: [Reconciliation contract](../plans/iracing-ibt-reconciliation-contract.md).
