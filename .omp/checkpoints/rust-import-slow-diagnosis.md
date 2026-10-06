Goal: Explain why Rust memory imports exceed Bun on six reported fixtures; isolate dominant F1 cost.
Acceptance: Evidence-backed causes, executed profiling/probes, workload-comparability caveats, concrete remedy. User's 20-trial results accepted; do not rerun to confirm.
Workspace: /Users/acoop/orca/workspaces/RaceIQ/rust-recorder
Constraints: Investigation only; preserve existing user edits; no permanent implementation changes planned.
[x] Located benchmark: apps/backend/test/benchmarks/recorder.bench.ts and native/recorder/src/imports/mod.rs.
    Verified: source inspection; release persistent worker timer excludes IPC and fixture reads.
[x] Profiled release Rust worker on F1, LMU, ACC; stage-timed current F1 parser/detector.
    Verified: profile-worker.ts and cargo release stage probe passed; JSON allocation/free dominates F1, repeated catalog resolution dominates LMU, deep cloning/free dominates ACC.
    Evidence: .omp/evidence/rust-import-slow/{f1,lmu,acc}-sample.txt, profile-shares.json, f1-stages.json.
    Sources: native/recorder/src/games/{f1,lmu,catalog}.rs; native/recorder/src/detection/{ordinal,kunos}.rs.
[x] Diagnosis complete; optimization targets and measurement caveats ready for user.
    Findings: F1 accepted packet counts match; no extra-packet explanation. Bun uses native JS objects/shared nested references; Rust owns B-tree JSON trees. Bun timing does not force GC.
    Limits: FM, AC Evo, iRacing not separately CPU-profiled; source evidence only. Outcome schemas differ, so six lap counts alone do not establish parity.
Decisions: Reuse reported measurements as baseline; targeted profiling only.
Blockers: None affecting diagnosis. find provider unavailable; literal search/source reads used. First ACC profile invocation used wrong filename and failed; canonical fixture profile passed.
Partial changes: No production edits. Temporary native stage example moved to .omp/evidence/rust-import-slow/stage-probe.rs; profiling scripts/results retained as evidence.
Processes/owners: All profiling jobs and scouts completed.
