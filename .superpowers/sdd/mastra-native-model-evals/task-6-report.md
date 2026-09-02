# Task 6 — persisted recommendation reporting

Implemented `mastra/evals/model-eval-recommendation.ts` with schemaVersion 2 report contracts and `buildModelRecommendation(mastra, experimentSetId, compareToExperimentSetId?)`. Reporting loads dataset experiments/results and score rows from Mastra persistence, validates score-to-result joins, derives eligibility/quality/diagnostics, retains evidence IDs/traces/usage, and performs persisted Mastra pairwise comparisons. Added disposable rich Markdown renderer and runner export wiring.

Verification: `bunx tsc --project tsconfig.json --noEmit` launched; full repository check owned by integration task. No formatter/linter/project-wide suite run.

Concerns: legacy tests/imports still reference `model-comparison.ts`; expected migration belongs to final cutover task. Baseline comparison-set matching remains pending integration refinement.
