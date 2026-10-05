Goal: Verify/debug actual child LMU DuckDB+WAL and MoTeC ZIP preview/import/replay independently of IBT smoke; edit only native/recorder/src/imports/lmu_duckdb.rs and motec.rs for evidenced defects.
Acceptance: isolated temp DATA_DIR/staging/UDP port 0 real debug child; LMU preview completedLapCount=2, import=2, first replay lapTime=15s, preserve uploaded WAL/metadata/telemetry; MoTeC real ZIP gameId acc carOrdinal0 trackOrdinal0, lap times preserved and ACC replay. Reference Bun contracts; no fake fallbacks. No builds/lint/tests/formatters; diagnostics permitted. Clean scaffolds. Parent owns build and HTTP smoke.
Workspace: /Users/acoop/orca/workspaces/RaceIQ/rust-recorder
Checkpoint: /Users/acoop/orca/workspaces/RaceIQ/rust-recorder/.omp/checkpoints/verify-rust-native-formats.md
Constraints: own two modules only; no parent smoke/HTTP wrappers/other modules.
[x] Construct standalone real-child protocol diagnostic and exercise MoTeC import/replay.
    Changed: temporary `.omp/checkpoints/rust-native-format-diagnostic.ts`, removed after tests.
    Verified: debug child HELLO/configure; actual test/artifacts/motec/acc-barcelona-porsche-992.zip supplied as `.motec.zip`, acc car/track 0; manifest packetCount 6164, one lap 1 time 102.71666666666667 (valid false), agrees apps/backend/test/e2e/motec-import.test.ts expectation >100 and <104. Copied source archive under DATA_DIR then `read-lap-window` succeeded with packetCount 6164 and gameId acc. No MoTeC module defect evidenced.
[x] Fix evidenced DuckDB child panic.
    Changed: native/recorder/src/imports/lmu_duckdb.rs `rows`: derive column count from executed query row-set instead of unexecuted prepared statement.
    Verified: prior debug child preview panicked at DuckDB raw_statement.rs:138 (`The statement was not executed yet`); source corrected. Rebuild/diagnostic not run (parent owns build; prohibited here).
[ ] Parent rebuild and verify LMU fixture contract completedLapCount=2, import=2, replay first lap=15; report result if available.
    Next: parent executes integrated build/HTTP smoke; this worker must not build.
Decisions: SQL fixture matched packages/game-lmu/test/support/duckdb.ts but built in standalone script; WAL was retained. Initial outputRoot outside staging rejected; corrected. MoTeC replay path needs source archive within configured DATA_DIR, matching authorized-capture contract.
Blockers: Freshly-built child not available after source edit; rebuild delegated to parent by task contract.
Partial changes: none outside owned module. Temporary diagnostic script removed.
Processes/owners: first diagnostic process run timed out after 300s due no request timeout; later diagnostics completed. No process intentionally retained.
