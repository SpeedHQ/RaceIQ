# Task 4 report

## Status
Implemented local OSS model matrix runner and `ai:model-eval` package script.

## Verification

Command:

```sh
EVAL_FIXTURE_ID=missing bun run ai:model-eval
```

Output:

```text
$ bun scripts/quality/model-eval.ts
Model eval setup failed: unknown fixture "missing" (available: acc-brands-hatch-2026-04-10)
error: script "ai:model-eval" exited with code 1
```

This confirms fixture selection rejects unknown IDs before endpoint access.

Planned full verification:

```sh
bun test test/ai/evals/model-comparison.test.ts test/ai/evals/model-eval-cases.test.ts test/ai/providers/analysis-provider-binding.test.ts --timeout 300000
bunx tsc --project tsconfig.json --noEmit
bun run ai:model-eval -- prism-ml/bonsai-27b qwen/qwen3.5-9b
```

## Concerns

- Full runner verification requires LM Studio serving both requested model IDs and is intentionally not run here.
- Runner writes timestamped JSON/Markdown artifacts only after successful preflight and fixture setup; generation/scoring failures produce partial reports and exit code 1.
