# Task 4 report

Implemented native Mastra trajectory/tool-protocol registration and telemetry correctness judge.

## Verification

Command:
```sh
bunx tsc --project tsconfig.json --noEmit 2>&1 | cut -c1-240 | grep -E 'mastra/evals/(index|scorers/telemetry)' || true
```
Output:
```text
(no output)
```

Command:
```sh
NODE_ENV=development bun -e 'const m=await import("./mastra/evals/index.ts"); console.log(Object.keys(m.scorerRegistry).filter(k=>k.includes("trajectory")||k.includes("tool-errors")||k.includes("telemetry"))); console.log(m.SCORER_THRESHOLDS["telemetry-correctness"],m.SCORER_THRESHOLDS["code-trajectory-scorer"],m.SCORER_THRESHOLDS["check-no-tool-errors"])'
```
Output:
```text
[ "code-trajectory-scorer", "check-no-tool-errors", "telemetry-correctness" ]
1 1 1
```

## Concerns

Full TypeScript output retains unrelated pre-existing errors in `client/src/stories/snapshot-cases.ts`, plus errors from superseded model-eval files being replaced by parallel tasks. No errors were emitted for touched scorer files. Telemetry judge requires configured local OpenAI-compatible endpoint when actually scoring; missing truth/context, empty output, malformed judge JSON, and request failures return score 0 with explicit reasons.
