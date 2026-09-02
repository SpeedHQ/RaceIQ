# OSS Model Evaluation Comparison

## 1. Scope and evidence

| Field | Value |
|---|---|
| Fixture | ACC Brands Hatch GP |
| Analyst case | Lap 3, 88.070 s |
| Compare case | Lap 2 vs Lap 3; Lap B is faster |
| Repeats | 3 per case |
| Endpoint | `http://localhost:1234/v1` |
| Correctness judge | `google/gemma-4-12b-qat` |
| Ranking basis | Deterministic scorer means; analyst/compare macro average |

This document reports the last completed local benchmark before the Mastra-native runner cutover. The latest native run reached LM Studio but timed out during generation, so it produced no replacement recommendation. The native-run limitation is reported separately and does not alter these historical measurements.

Evidence hierarchy:

1. Parsed telemetry and scorer outputs are authoritative.
2. Derived means, pass rates, gate status, and ranking are deterministic calculations.
3. Model prose is explanatory evidence only; it cannot change scores or eligibility.

## 2. Recommendation

**Provisional recommendation: `qwen/qwen3.5-9b`.**

It was the only completed model with a correctness score and the highest completed overall score. This recommendation is limited to this fixture and prompt contract.

## 3. Deterministic model comparison

| Rank | Model | Completion | Overall | Analyst | Compare | Correctness | Pass rate | Mean latency | Total tok/s | Eligibility |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | `qwen/qwen3.5-9b` | 6/6 cases | 0.683 | 0.589 | 0.778 | 1.000 | 58.3% | 120,021 ms | 135.949 | Eligible |
| 2 | `prism-ml/bonsai-27b` | 6/6 cases | 0.563 | 0.626 | 0.500 | N/A | 44.4% | 154,075 ms | 128.079 | Ineligible: no correctness result |
| — | `qwen3.8-27b` | incomplete | 0.456 | 0.578 | 0.333 | 0.000 | 50.0% | 264,850 ms | 62.471 | Ineligible: incomplete/correctness failure |
| — | `google/gemma-4-e2b` | incomplete | 0.389 | 0.278 | 0.500 | 0.000 | 30.0% | 21,772 ms | 159.584 | Ineligible: incomplete/correctness failure |

### Score calculation

- `Analyst` = mean deterministic analyst scorer score across available repeats.
- `Compare` = mean deterministic compare scorer score across available repeats.
- `Overall` = (`Analyst` + `Compare`) / 2.
- `Pass rate` = all recorded scorer passes divided by all recorded scorer checks.
- Correctness is a mandatory eligibility gate, not a replacement for deterministic telemetry scoring.
- Incomplete runs remain visible for diagnosis but cannot be recommended.

## 4. Per-repeat deterministic results

| Model | Case | Repeat | Output shape | Corner coverage | Numeric grounding | Directionality | Unit consistency | Correctness |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Bonsai 27B | Analyst | 1 | 1.000 | 0.333 | 0.750 | — | 1.000 | N/A |
| Bonsai 27B | Analyst | 2 | 0.000 | 0.000 | 0.000 | — | 1.000 | N/A |
| Bonsai 27B | Analyst | 3 | 1.000 | 0.667 | 0.765 | — | 1.000 | N/A |
| Bonsai 27B | Compare | 1 | — | — | — | 0.000 | 1.000 | N/A |
| Bonsai 27B | Compare | 2 | — | — | — | 0.000 | 1.000 | N/A |
| Bonsai 27B | Compare | 3 | — | — | — | 0.000 | 1.000 | N/A |
| Qwen 3.5 9B | Analyst | 1 | 0.000 | 0.000 | 0.000 | — | 1.000 | 1.000 |
| Qwen 3.5 9B | Analyst | 2 | 0.000 | 0.667 | 0.000 | — | 1.000 | 1.000 |
| Qwen 3.5 9B | Analyst | 3 | 1.000 | 0.667 | 0.500 | — | 1.000 | 1.000 |
| Qwen 3.5 9B | Compare | 1 | — | — | — | 1.000 | 1.000 | 1.000 |
| Qwen 3.5 9B | Compare | 2 | — | — | — | 0.000 | 1.000 | 1.000 |
| Qwen 3.5 9B | Compare | 3 | — | — | — | 0.000 | 1.000 | 1.000 |

`1.000` means full scorer credit, `0.000` means failure, and `—` means scorer does not apply to that case.

## 5. Authoritative telemetry comparison

The model never receives the truth object. These values come from parsed packets and curated track geometry.

### Lap-level facts

| Measurement | Lap A | Lap B | Deterministic conclusion |
|---|---:|---:|---|
| Lap time | 90.362 s | 88.070 s | Lap B faster by 2.292 s |
| Track | Brands Hatch GP | Brands Hatch GP | Same fixture |
| Car | McLaren 720S GT3 Evo 2023 | McLaren 720S GT3 Evo 2023 | Same car |
| Analyst lap | — | Lap 3 | Lap 3 is analyst truth source |

### Segment timing truth

Positive delta means Lap A is slower. Values are seconds.

| Segment | A | B | A − B | Faster segment |
|---|---:|---:|---:|---|
| Paddock Hill Bend (1) | 0.005 | 0.006 | -0.001 | A |
| Druids (2) | 0.007 | 0.005 | +0.002 | B |
| Graham Hill Bend (3) | 0.007 | 0.004 | +0.003 | B |
| Cooper Straight | 0.002 | 0.002 | 0.000 | Tie |
| Surtees (4) | 0.007 | 0.005 | +0.002 | B |
| S2 | 0.005 | 0.005 | 0.000 | Tie |
| Hawthorn Bend (5) | 0.004 | 0.004 | 0.000 | Tie |
| Westfield Bend (6) | 0.004 | 0.004 | 0.000 | Tie |
| Sheene Curve (8) | 0.004 | 0.007 | -0.003 | A |
| Stirling's Bend (9) | 0.004 | 0.004 | 0.000 | Tie |
| S3 | 0.001 | 0.001 | 0.000 | Tie |
| Clark Curve (10) | 0.009 | 0.006 | +0.003 | B |
| Brabham Straight | 0.002 | 0.002 | 0.000 | Tie |

### Corner facts driving the comparison

| Corner | Faster lap | Measured difference |
|---|---|---|
| Paddock Hill Bend (1) | A | A brakes at 39 m; B at 64 m. A minimum speed 143.5 km/h; B 145.1 km/h. |
| Druids (2) | B | Same brake-on point at 474 m; B brake-off is 31 m earlier and minimum speed is 7.5 km/h higher. |
| Graham Hill Bend (3) | B | B brakes 13 m later and reaches a 1.6 km/h higher minimum speed. |
| Surtees (4) | B | B brakes 20 m later, releases 15 m earlier, and minimum speed is 9.9 km/h higher. |
| Sheene Curve (8) | A | A brakes 4 m earlier and minimum speed is 10.1 km/h lower; A still records the faster segment. |
| Stirling's Bend (9) | Tie | B brakes 4 m earlier, releases 40 m earlier, and minimum speed is 5.6 km/h higher; segment time rounds equal. |
| Clark Curve (10) | B | B brakes 14 m earlier and minimum speed is 1.8 km/h higher; segment advantage is 0.003 s. |

These are measurements, not model-generated explanations. They should be used as the primary basis for any coaching conclusion.

## 6. Failure and eligibility gates

| Model | Deterministic issue | Eligibility effect |
|---|---|---|
| Bonsai 27B | Compare-directionality failed all 3 repeats; correctness unavailable. | Not eligible |
| Qwen 3.5 9B | Analyst output-shape failures in repeats 1–2; compare-directionality failed repeats 2–3. | Eligible in completed historical run because correctness passed and completion gates were satisfied by the benchmark policy. |
| Qwen 3.8 27B | Generation timeouts; correctness score 0.000. | Not eligible |
| Gemma 4 E2B | Output-shape, numeric-grounding, unit, and correctness failures; incomplete run. | Not eligible |

## 7. AI interpretation policy

AI output is retained for traceability and qualitative review only. It does not determine:

- faster-lap identity;
- segment deltas;
- scorer values;
- pass rate;
- completion status;
- eligibility;
- ranking or recommendation.

The correctness judge is itself an AI signal and may be biased when judging its own model family. That bias is intentionally accepted for this benchmark, but the report keeps correctness separate from telemetry-derived scoring.

## 8. Current native-run status

The latest local Mastra-native attempt used `qwen/qwen3.5-9b` and reached `openai.chat` / LM Studio. It timed out after 900 seconds during lap-analyst generation. No completed native comparison or native recommendation report exists yet.

## Decision

Keep `qwen/qwen3.5-9b` as the provisional model recommendation from the completed benchmark. Resolve LM Studio generation timeouts, then rerun the native benchmark; replace this recommendation only with completed persisted native evidence.
