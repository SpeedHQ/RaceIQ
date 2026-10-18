# Scheduled recording maintenance

Recording maintenance combines compression, optional historical downsampling, optional deletion, and file cleanup. The backend owns job lifecycle, policy, eligibility, database publication, and caches; `@raceiq/capture-downsampling` owns streaming inspection and rewriting, using codecs from `@raceiq/capture-formats`. This guide documents current behavior, not a generic Effect pattern.

## Runtime and entry points

[`server/session-capture/maintenance-runtime.ts`](../../server/session-capture/maintenance-runtime.ts) lazily creates one `ManagedRuntime` for a backend lifecycle. It owns admission (`Ref` state: `idle`, `maintenance`, `downsample`, `stopping`), status, and tracked fibers. `admitMaintenance` uses atomic `Ref.modify`, so only one scheduled pass or manual storage job can own the maintenance slot. Downsampling additionally reserves storage through `reserveRecordingStorageOperation("downsample")`; that lease coordinates with import/move operations. Manual admission acknowledges through `Deferred` only after checks and reservation succeed.

- `startSessionCompressor()` starts the idempotent server-owned scheduler. `runSessionCaptureMaintenanceNow()` awaits one pass.
- `POST /api/storage/session-downsample/preview` calls `previewSessionDownsample()` and reads/plans without rewriting.
- `POST /api/storage/session-downsample` calls `startSessionDownsample()`, returning `202` only after worker admission/storage acquisition succeeds. Busy work returns `409`.
- `GET /api/storage/session-downsample` calls `getSessionDownsampleStatus()`. Status includes progress, converted file count, actual freed bytes, skipped groups, and per-group failures. `runSessionDownsampleNow()` is the Promise facade for callers that need to await a manual run.
- `stopSessionCompressor()` awaits `disposeRecordingMaintenanceRuntime()`. [`apps/backend/src/runtime/shutdown.ts`](../../apps/backend/src/runtime/shutdown.ts) awaits this before stopping ingress and flushing the recorder.

Routes remain Promise boundaries; Effect programs do not call `Effect.run*`. Work is a managed-runtime fiber, not a detached request task. Effect fibers coordinate lifecycle; they do not move CPU-bound work onto another CPU worker.

## Schedule and pass ordering

`sessionMaintenanceSchedule()` runs the first pass immediately, then uses `Schedule.spaced("5 minutes")`: each next pass is five minutes after the previous pass completes. A slow pass cannot overlap itself or create a backlog. Recoverable pass failures are logged and repetition continues; a failed downsample stage prevents deletion in that pass.

`maintenancePassEffect()` in [`server/session-capture/compressor.ts`](../../server/session-capture/compressor.ts) runs stages in order:

1. Compress eligible recordings.
2. Load fresh settings and validate the complete retention policy.
3. If enabled and no capture is active, automatically downsample recordings strictly older than the configured age.
4. If enabled and no capture is active, delete recordings strictly older than the configured deletion age.
5. Clean orphan recordings, expired staged MoTeC imports, and only this operation's interrupted downsample temporary files.

Ordinary downsample skips (for example favorites or unsupported timebases) do not fail the stage. A failed/partial automatic downsample skips deletion for that pass. Disabled downsampling leaves existing deletion behavior intact. Cleanup uses the shared session-capture maintenance lock; each downsample group is re-planned and rechecked while holding it.

Defaults: automatic downsampling is disabled, age 30 days, target 50 Hz; automatic deletion is disabled, age 90 days. When both are enabled, deletion age must be strictly greater than downsample age. Age eligibility is based on session `createdAt` and strict `< cutoff`; a recording exactly at the cutoff is not eligible. Example: downsample at 50 Hz after 30 days, delete after 90 days. Manual `all` and `older-than` jobs do not modify these settings.

## Eligibility and sampling semantics

Manual and scheduled jobs operate on eligible database-referenced canonical sparse `.bin`/`.bin.gz` capture groups. UDP-origin recordings are included; this historical operation does not alter live UDP capture. MoTeC archives, missing/unowned files, unsupported/legacy data, mixed-game groups, and streams without reliable timing are left unchanged and reported with skip reasons. Any favorite session or lap protects the entire shared file. For age-limited requests, every session referencing a shared file must satisfy the age cutoff; otherwise the group is skipped as a shared-age conflict.

Live native capture frequency is separately configured: 100 Hz default is a ceiling, constrained by source rate, and is not an upsampling promise. Archival targets likewise never manufacture samples. The downsampling engine in [`packages/capture-downsampling/src/index.ts`](../../packages/capture-downsampling/src/index.ts) validates and streams records in two passes with bounded buffers and lap/stream planning. Eligibility estimates each telemetry stream's average rate from its first 1,000 samples (or the whole stream when shorter), using persisted recorder timestamps when complete; otherwise only Forza Motorsport's unwrapped `TimestampMS` or F1 session time scoped by session UID is a supported fallback. Streams with fewer than two timed samples or nonpositive sample spans are skipped as unreliable. Average rates are rounded to the nearest Hz; if every stream measures at or below target + 3 Hz, the recording is skipped without rewrite or cap update. Native captures missing complete recorder timestamps are skipped as unreliable. Timestamp regressions rephase admission rather than generating catch-up frames.

Segment boundaries reset stream state. Segment context and its markers are retained. F1 samples are admitted independently for MOTION, CAR_TELEMETRY, and MOTION_EX packet streams; ancillary packet families remain unthrottled and ordered. iRacing nested source deltas are all decoded before selection, then selected reconstructed snapshots are re-encoded through fresh source and sparse encoders. Sparse recording deltas are rebuilt, not copied across dropped frames. The configured rate describes telemetry sampling, not a total packet cap. First/last telemetry and indexed lap boundary records are retained, so local samples may exceed the target.

## Publication, indexes, and recovery

The backend planner in [`server/session-capture/session-downsample.ts`](../../server/session-capture/session-downsample.ts) groups rows by resolved file path and reports source byte size, not promised savings. Before publication it rechecks active capture/layout state, settings, file identity, all database references, favorites, and expected lap indexes under the shared lock. The rewrite writes an exclusive unique sibling file preserving compression, then strictly validates replay and remapped lap windows before database publication.

Lap windows count **all frame records**, including ancillary frames; metadata records do not count. Null raw indexes stay null. For indexed laps, retained start/end records keep the span contiguous; new byte offset and all-frame count are committed without redetecting laps or changing lap identity, times, notes, favorites, validity, sectors, or relationships. `commitSessionDownsample` atomically rechecks references/indexes, updates paths and target cap, and invalidates affected derived metrics/analyses/capture facts. Because the replacement is already validated, the transaction also marks its dashboard capture facts ready for processing; post-commit finalization failures cannot leave them blocked. Capture caches are cleared after commit.

If no frames are removed after preflight establishes the source rate exceeds the target, the validated sibling is discarded and a cap-only transaction records the established target without replacing the file or invalidating derived results. Recordings measured at or below the requested target are skipped before rewriting, so a 50 Hz recording is not needlessly processed for a 50 or 80 Hz request. A target whose output is not smaller on disk is discarded and reported as `not-smaller`; no cap is claimed. A persisted cap at or below a requested target makes a group idempotently ineligible; a lower target can process it again. After successful replacement commit, the old file is unlinked only if no database reference remains. An unlink/finalization failure is a warning: the validated replacement remains authoritative and orphan cleanup can remove the old file.

The format layer's temporary names are narrowly scoped (`.downsample-…`) and cleanup removes only matching owned operation temporaries while holding the maintenance lock. A pre-commit failure preserves the original path/data and removes uncommitted output where safe. Publication ordering also leaves an unreferenced sibling recoverable as an orphan after a crash before commit, while a committed replacement remains authoritative after a crash afterward.

## Interruption and lifecycle limits

JavaScript Promise I/O already in progress is not cancelled by interrupting its Effect fiber. Each locked file operation and final validation/publication bookkeeping is therefore protected until settlement; interruption is allowed between groups. Locks and storage reservations must not be released while their I/O is still running. Shutdown marks admission stopping, interrupts/awaits tracked fibers and finalizers, disposes the runtime, then proceeds with ingress shutdown. Shutdown can wait for protected I/O.

There is no cancel API. Jobs survive browser navigation because they are backend-owned, and the Storage UI polls status while running, displays inline progress/results/skips/failures, and offers retry after partial/error. Established caps cause completed groups to be skipped on retry. Jobs do not survive backend restart with resumable progress; persisted paths/caps support safe later work, but there is no durable workflow engine or exactly-once crash guarantee. Downsampling permanently removes telemetry detail and cannot be undone without a backup. Manual starts require explicit confirmation and a backup warning; automatic processing requires a saved opt-in policy.

## Tests

Run the existing isolated backend suites from the repository root:

```bash
bun run --cwd apps/backend test
```

Relevant coverage lives in `apps/backend/test/session-capture/session-downsample.test.ts`, `session-downsample-rewrite.test.ts`, `session-downsample-publication.test.ts`, `session-downsample-routes.test.ts`, `automatic-cleanup.test.ts`, and `recording-maintenance-lifecycle.test.ts`. The lifecycle suite uses `TestClock`, `Deferred`, and owned fibers to verify immediate execution, spacing after completion, non-overlap, recovery after a failed pass, admission ownership, and shutdown waiting for non-cancellable work. Rewrite tests are in `packages/capture-downsampling/test/session-downsample.test.ts`, run with `bun run --cwd packages/capture-downsampling test`; server capture byte/lifecycle tests are run with `bun run --cwd server test`.
