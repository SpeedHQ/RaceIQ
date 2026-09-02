# Task 6 — persisted recommendation reporting

Implemented `mastra/evals/model-eval-recommendation.ts` with schemaVersion 2 report contracts and `buildModelRecommendation(mastra, experimentSetId, compareToExperimentSetId?)`. Reporting loads dataset experiments/results and score rows from Mastra persistence, validates score-to-result joins, derives eligibility/quality/diagnostics, retains evidence IDs/traces/usage, and performs persisted Mastra pairwise comparisons. Added disposable rich Markdown renderer and runner export wiring.

Verification: `bunx tsc --project tsconfig.json --noEmit` launched; full repository check owned by integration task. No formatter/linter/project-wide suite run.


## Review repair

Reworked persisted aggregation to retain malformed results as failures, enforce six-result cardinality, reject duplicate observation keys, require persisted score rows, and gate experiment/tool/trajectory errors. Target IDs are `lap-analyst` and `compare-engineer`; current and baseline comparisons require exactly one `(modelId, agent)` match and call `compareExperiments` for every pair. Markdown now includes reproducibility metadata, IDs/traces, scorer reasons, output excerpts, telemetry truth, failures, and comparison deltas.

Verification output:

```text
No recommendation-module diagnostics from:
bunx tsc --project tsconfig.json --noEmit 2>&1 | python3 -c 'import sys; print("\n".join(x for x in sys.stdin if "model-eval-recommendation" in x))'
```

Concerns: recommendation fixture tests were not present at assigned path; full suite and formatter remain integration-owned.
Concerns: legacy tests/imports still reference `model-comparison.ts`; expected migration belongs to final cutover task. Baseline comparison-set matching remains pending integration refinement.
