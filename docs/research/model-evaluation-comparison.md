# OSS Model Evaluation Comparison

## Scope

ACC Brands Hatch fixture: analyst lap 3 and comparison laps 2 vs 3. Three repeats per case. Endpoint: `http://localhost:1234/v1`. Correctness judge: `google/gemma-4-12b-qat`.

These figures are from the last completed local benchmark before the Mastra-native runner cutover. The latest native runner reached LM Studio but timed out during generation, so it produced no replacement recommendation.

## Recommendation

**`qwen/qwen3.5-9b`** was the only model eligible for recommendation in the completed benchmark.

## Model comparison

| Rank | Model | Status | Overall | Analyst | Compare | Correctness | Pass rate | Mean latency | Tokens/s |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | `qwen/qwen3.5-9b` | complete | 0.683 | 0.589 | 0.778 | 1.000 | 58.3% | 120,021 ms | 135.949 |
| 2 | `prism-ml/bonsai-27b` | complete | 0.563 | 0.626 | 0.500 | N/A | 44.4% | 154,075 ms | 128.079 |
| — | `qwen3.8-27b` | incomplete | 0.456 | 0.578 | 0.333 | 0.000 | 50.0% | 264,850 ms | 62.471 |
| — | `google/gemma-4-e2b` | incomplete | 0.389 | 0.278 | 0.500 | 0.000 | 30.0% | 21,772 ms | 159.584 |

Quality ranking uses the macro average of analyst and compare scores. Latency and throughput are diagnostic only.

## Interpretation

- `qwen/qwen3.5-9b`: strongest completed result; perfect correctness score and best compare score. Output-shape failures reduced analyst score.
- `prism-ml/bonsai-27b`: stronger analyst score, but compare-directionality failed on all three repeats and no correctness judge result was available.
- `qwen3.8-27b`: incomplete due generation timeouts; correctness judge rejected the completed outputs that were available.
- `google/gemma-4-e2b`: fastest, but incomplete and weak on structured output, numeric grounding, and correctness.

## Decision

Use `qwen/qwen3.5-9b` as the provisional OSS model recommendation for this fixture and prompt contract. Re-run the Mastra-native benchmark after LM Studio generation timeouts are resolved; do not treat this document as replacement evidence for that run.
