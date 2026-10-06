Goal: Build optimized production Rust variant with allocation-conscious practices, preserving behavior.
Acceptance: F1 typed detector path; LMU indexed/cached metadata and static layouts; Kunos clone elimination; six-fixture complete semantic parity and measured performance; full live/replay telemetry preserved.
Workspace: /Users/acoop/orca/workspaces/RaceIQ/rust-recorder
Plan: docs/plans/optimized-rust-imports.md
ADR: docs/adr/0002-optimized-rust-imports.md (proposed); reciprocal links verified.
Constraints: No benchmark-only shortcuts, packet dropping, unsafe, or unrelated-change overwrite. No commits requested or made.
[x] F1/ordinal: direct typed production import projection, compact policy samples, borrowed live ordinal input; presentation output unchanged.
[x] LMU: indexed borrowed resolvers with exact ambiguity/tier rules, parser-local invalidating identity cache, generated layout constants, borrowed source-frame slices.
[x] Kunos: compact typed samples; no packet/lap clones; full append packets and original duplicate boundary cadence preserved. Semantic mismatch during integration corrected and regression added.
[x] Decoder: borrowed typed identities and record-index checkpoints eliminate transient strings/frame copies; sparse chain/boundary regressions passed.
[x] Verification: native suite passed; debug/release builds passed; full canonical F1 typed/full comparison passed; production replay/import contracts passed, affected Kunos scenarios rerun after correction.
[x] Release worker: six fixtures, one warmup plus20 measured imports each; complete normalized result hashes match original baseline including all ordered events/recipes. Timing data in evidence, not checkpoint.
[x] Docs/changelog updated; changelog tests passed. Temporary verification harness removed; original diagnosis evidence preserved.
Verification details: .omp/evidence/optimized-rust-imports/verification.json
Timing/hash evidence: .omp/evidence/optimized-rust-imports/{baseline,optimized}.json and *-baseline-result.json.
Runtime/build proof: .omp/evidence/optimized-rust-imports/{native-correction-gate,build-and-f1-equivalence,production-contracts,production-correction-and-timing,changelog-tests}.log
Decisions/limits: Preserve existing detector semantics including numeric typing and boundary sample cadence. Bun timing report not rerun. FM no improvement; non-F1 fixtures still favor reported Bun medians. Windows native acquisition not exercised.
Next: Complete; final response with measured results and verification. Reproduce timing via existing bench:recorder import mode; canonical F1 equivalence via ignored release fixture test.
Blockers: None affecting delivery. Required skill://adr unavailable; repository-format plan/ADR saved directly. Rust LSP unavailable; source references fallback used.
Partial changes: Completed native implementation, README/CHANGELOG, new plan/ADR, untracked checkpoint/evidence; no unfinished code. Preexisting diagnosis checkpoint/evidence preserved.
Processes/owners: None active; all workers and gates completed.
