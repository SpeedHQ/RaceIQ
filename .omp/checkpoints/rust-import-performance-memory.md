Goal: Hyper-optimize production Rust imports with allocation-conscious best practices; retain timing and memory differences.
Acceptance: Eliminate steady-state presentation JSON for Kunos/iRacing; compact deferred state and indexed SDK lookup; remove decoder/import copies; preserve complete six-fixture outcomes, full live/replay telemetry, boundary append packets, source offsets and numeric/missing-field semantics; measure throughput and isolated RSS differences.
Workspace: /Users/acoop/orca/workspaces/RaceIQ/rust-recorder
Checkpoint: /Users/acoop/orca/workspaces/RaceIQ/rust-recorder/.omp/checkpoints/rust-import-performance-memory.md
Plan: docs/plans/optimized-rust-imports.md
ADR: docs/adr/0002-optimized-rust-imports.md (proposed); reciprocal links verified.
Constraints: Preserve prior user changes; no commits requested/made. No unsafe, benchmark-only shortcuts, packet dropping, or policy changes.
[x] Prior pass: ACC identity cache/static iRacing names and isolated memory comparison CLI; evidence .omp/evidence/rust-import-performance-memory/verification.json.
[x] Kunos: borrowed lazy boundary materializer, single parser advance, typed snapshots; full adapters share transitions. games/kunos.rs, detection/kunos.rs.
[x] iRacing: indexed scalar projection, numeric UID, compact deferred samples; literal-key timing gate preserved. games/iracing.rs, detection/{iracing,ordinal}.rs.
[x] Decoder/import: shared lending core, borrowed raw input, reusable sparse storage, streamed import/replay and moved result trees. formats/{mod,sparse}.rs, imports/{archive,capture,replay,ibt}.rs.
[x] Integration: lifetime-bearing DetectionPacket; live detector adapters borrow full packets. games/{mod,f1}.rs, detection/mod.rs.
[x] Verification: native suite 65 passed; three release canonical typed/full checks passed; complete six-fixture parity passed. Evidence .omp/evidence/rust-typed-hotpaths/verification.json.
[x] Production smoke: six-game import/replay plus MoTeC ZIP and manifest contracts, 9 passed/830 assertions; production-contracts.log in same evidence directory.
[x] Measurements: fresh Bun/Rust reports, matched native before/after series, separate RSS runs; .omp/evidence/rust-typed-hotpaths/{bun,rust,summary,before,after,verify}.json.
[x] Docs: recorder-baseline README/current comparison and Unreleased changelog updated; changelog tests 11 passed.
Decisions: Full JSON at consumer boundaries; exact existing policy, including incidental iRacing literal SDK gate. RSS measures whole-process footprint; Rust includes stdio/base64; engine result schemas differ.
Blockers: None. Windows acquisition unverified; find 403 and Rust LSP unavailable during research. FM/LMU showed no meaningful matched-series improvement.
Partial changes: None unfinished. All changes remain uncommitted; earlier user edits preserved.
Processes/owners: Cutover workers finished; no owned jobs/services remain.
Next: Deliver verified timing/RSS comparison and remaining FM/LMU limitations. No pending implementation.
