# OSS Model Evaluation

## Executive summary
- Dataset: **ACC Brands Hatch fixture** (acc, metric; analyst lap 3; compare laps 2 vs 3)
- Generated: `2026-09-02T12:30:30.705Z`
- Endpoint: `http://localhost:1234/v1`
- Repeats: **3 per case**
- Correctness judge: **google/gemma-4-12b-qat**
- Recommendation scope: this dataset and prompt contract only.

### Recommendation
**qwen/qwen3.5-9b**

## Authoritative telemetry truth
Truth is generated from parsed packets and curated geometry, independent of model output. Full truth objects are embedded in the JSON artifact.

- **acc-brands-hatch-2026-04-10-lap-3-analyst** — lap 3 (88.070 s), 13 segments, slowest corners are fixture-derived
- **acc-brands-hatch-2026-04-10-laps-2-vs-3-compare** — faster lap: B, 9 corner deltas

## Model comparison

Quality ranking uses macro average of Analyst and Compare scores. Latency and throughput are reported for diagnosis, not ranking.

| Rank | Model | Status | Overall | Analyst | Compare | Correctness | Pass rate | Mean latency | Input tok | Output tok | Thinking tok | Total tok | tok/s |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | prism-ml/bonsai-27b | complete | 0.563 | 0.626 | 0.500 | N/A | 44.4% | 154075 ms | 5885.500 | 10818.500 | 8681.167 | 16704.000 | 128.079 |
| 1 | qwen/qwen3.5-9b | complete | 0.683 | 0.589 | 0.778 | 1.000 | 58.3% | 120021 ms | 5889.000 | 9124.167 | 7170.000 | 15013.167 | 135.949 |
| N/A | qwen3.8-27b | incomplete | 0.456 | 0.578 | 0.333 | 0.000 | 50.0% | 264850 ms | 6771.000 | 9562.667 | 7025.333 | 16333.667 | 62.471 |
| N/A | google/gemma-4-e2b | incomplete | 0.389 | 0.278 | 0.500 | 0.000 | 30.0% | 21772 ms | 5403.000 | 2447.300 | 821.400 | 7850.300 | 159.584 |

## Scorer breakdown
Each scorer is averaged across repeats. Reasons are retained below in case evidence.

| Model | Scorer | Mean | Population SD | Passed | Total |
|---|---|---:|---:|---:|---:|
| prism-ml/bonsai-27b | output-shape | 0.667 | 0.471 | 2 | 3 |
| prism-ml/bonsai-27b | corner-coverage | 0.333 | 0.272 | 0 | 3 |
| prism-ml/bonsai-27b | numeric-grounding | 0.505 | 0.357 | 0 | 3 |
| prism-ml/bonsai-27b | unit-consistency | 1.000 | 0.000 | 3 | 3 |
| prism-ml/bonsai-27b | compare-directionality | 0.000 | 0.000 | 0 | 3 |
| prism-ml/bonsai-27b | unit-consistency | 1.000 | 0.000 | 3 | 3 |
| qwen/qwen3.5-9b | output-shape | 0.333 | 0.471 | 1 | 3 |
| qwen/qwen3.5-9b | corner-coverage | 0.444 | 0.314 | 0 | 3 |
| qwen/qwen3.5-9b | numeric-grounding | 0.167 | 0.236 | 0 | 3 |
| qwen/qwen3.5-9b | unit-consistency | 1.000 | 0.000 | 3 | 3 |
| qwen/qwen3.5-9b | correctness | 1.000 | 0.000 | 3 | 3 |
| qwen/qwen3.5-9b | compare-directionality | 0.333 | 0.471 | 1 | 3 |
| qwen/qwen3.5-9b | unit-consistency | 1.000 | 0.000 | 3 | 3 |
| qwen/qwen3.5-9b | correctness | 1.000 | 0.000 | 3 | 3 |
| qwen3.8-27b | output-shape | 1.000 | 0.000 | 1 | 1 |
| qwen3.8-27b | corner-coverage | 0.000 | 0.000 | 0 | 1 |
| qwen3.8-27b | numeric-grounding | 0.889 | 0.000 | 1 | 1 |
| qwen3.8-27b | unit-consistency | 1.000 | 0.000 | 1 | 1 |
| qwen3.8-27b | correctness | 0.000 | 0.000 | 0 | 1 |
| qwen3.8-27b | compare-directionality | 0.000 | 0.000 | 0 | 1 |
| qwen3.8-27b | unit-consistency | 1.000 | 0.000 | 1 | 1 |
| qwen3.8-27b | correctness | 0.000 | 0.000 | 0 | 1 |
| google/gemma-4-e2b | output-shape | 0.000 | 0.000 | 0 | 3 |
| google/gemma-4-e2b | corner-coverage | 0.778 | 0.157 | 1 | 3 |
| google/gemma-4-e2b | numeric-grounding | 0.000 | 0.000 | 0 | 3 |
| google/gemma-4-e2b | unit-consistency | 0.333 | 0.471 | 1 | 3 |
| google/gemma-4-e2b | correctness | 0.000 | 0.000 | 0 | 0 |
| google/gemma-4-e2b | compare-directionality | 0.333 | 0.471 | 1 | 3 |
| google/gemma-4-e2b | unit-consistency | 1.000 | 0.000 | 3 | 3 |
| google/gemma-4-e2b | correctness | 0.000 | 0.000 | 0 | 2 |

## Case evidence

| Model | Case | Repeat | Scorer | Score | Reason |
|---|---|---:|---|---:|---|
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | output-shape | 1.000 | valid |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | corner-coverage | 0.333 | missed: Druids, Graham Hill Bend (score 0.33) |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | numeric-grounding | 0.750 | 12 analysis entries checked (score 0.75) |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | unit-consistency | 1.000 | clean |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | output-shape | 0.000 | pace.0.value: Invalid input: expected string, received number; pace.2.value: Invalid input: expected string, received number; pace.3.value: Invalid input: expected string, received number; handling.0.value: Invalid input: expected string, received number; handling.1.value: Invalid input: expected string, received number; handling.2.value: Invalid input: expected string, received number |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | corner-coverage | 0.000 | missed: Druids, Graham Hill Bend, Surtees (score 0.00) |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | numeric-grounding | 0.000 | output failed to parse — cannot score grounding |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | unit-consistency | 1.000 | clean |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | output-shape | 1.000 | valid |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | corner-coverage | 0.667 | missed: Druids (score 0.67) |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | numeric-grounding | 0.765 | 13 analysis entries checked (score 0.76) |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | unit-consistency | 1.000 | clean |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | unit-consistency | 1.000 | clean |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | unit-consistency | 1.000 | clean |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| prism-ml/bonsai-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | unit-consistency | 1.000 | clean |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | output-shape | 0.000 | setup.0.component: Invalid input: expected string, received undefined; setup.0.symptom: Invalid input: expected string, received undefined; setup.0.fix: Invalid input: expected string, received undefined; setup.0.current: Invalid input: expected string, received undefined; setup.0.target: Invalid input: expected string, received undefined; setup.0.direction: Invalid option: expected one of "increase"\|"decrease"\|"adjust" |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | corner-coverage | 0.000 | missed: Druids, Graham Hill Bend, Surtees (score 0.00) |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | numeric-grounding | 0.000 | output failed to parse — cannot score grounding |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | unit-consistency | 1.000 | clean |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | correctness | 1.000 | judge: answer is faithful to the source context |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | output-shape | 0.000 | setup.0.component: Invalid input: expected string, received undefined; setup.0.symptom: Invalid input: expected string, received undefined; setup.0.fix: Invalid input: expected string, received undefined; setup.0.current: Invalid input: expected string, received undefined; setup.0.target: Invalid input: expected string, received undefined; setup.0.direction: Invalid option: expected one of "increase"\|"decrease"\|"adjust" |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | corner-coverage | 0.667 | missed: Graham Hill Bend (score 0.67) |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | numeric-grounding | 0.000 | output failed to parse — cannot score grounding |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | unit-consistency | 1.000 | clean |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | correctness | 1.000 | judge: answer is faithful to the source context |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | output-shape | 1.000 | valid |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | corner-coverage | 0.667 | missed: Graham Hill Bend (score 0.67) |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | numeric-grounding | 0.500 | 13 analysis entries checked (score 0.50) |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | unit-consistency | 1.000 | clean |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | correctness | 1.000 | judge: answer is faithful to the source context |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | compare-directionality | 1.000 | correct: faster = Lap B |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | unit-consistency | 1.000 | clean |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | correctness | 1.000 | judge: answer is faithful to the source context |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | unit-consistency | 1.000 | clean |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | correctness | 1.000 | judge: answer is faithful to the source context |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | unit-consistency | 1.000 | clean |
| qwen/qwen3.5-9b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | correctness | 1.000 | judge: answer is faithful to the source context |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | output-shape | 1.000 | valid |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | corner-coverage | 0.000 | missed: Druids, Graham Hill Bend, Surtees (score 0.00) |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | numeric-grounding | 0.889 | 14 analysis entries checked (score 0.89) |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | unit-consistency | 1.000 | clean |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | correctness | 0.000 | judge flagged unsupported/contradicted claims: The response uses the term 'over-brading' and 'trail-brading' repeatedly, which are not real racing terms and appear to be hallucinations or typos for 'over-braking' and 'trail-braking'.; The response includes a 'Brake Bias (Front)' entry in the 'handling' section with a 'warning' assessment, but the schema for 'handling' does not include a 'value' field for the 'assessment' key in the way it was structured, and it also fails to follow the 'specific number/stat' requirement for the 'value' field in that specific object.; The response includes a 'Brake Bias (Front)' entry in the 'handling' section, but the prompt instructions for 'setup' require specific formatting for setup changes (Parameter, Current, Change to, Purpose), which the response failed to use for the brake bias advice in the handling section.; The response mentions 'Surties (4)' in the corners section, but the correct name from the source is 'Surtees (4)'.; The response mentions 'over-brading' as a reason for time loss, which is not a concept provided in the source telemetry or track guide.; The response provides a 'Brake Bias' value of '75%' in the handling section but does not provide a 'value' field for the 'assessment' key, violating the JSON schema provided in the prompt. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | unit-consistency | 1.000 | clean |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | correctness | 0.000 | judge flagged unsupported/contradicted claims: The verdict claims differences of 0.000-0.002 seconds per segment, but the SOURCE shows differences as high as +0.011s (Druids) and +0.006s (S2).; The deltaSeconds for Paddock Hill Bend (1) is stated as 0.000, but the SOURCE is -0.001.; The deltaSeconds for Druids (2) is stated as 0.000, but the SOURCE is +0.011.; The deltaSeconds for Graham Hill Bend (3) is stated as 0.002, but the SOURCE is -0.003.; The deltaSeconds for Cooper Straight is stated as -0.001, but the SOURCE is +0.000.; The deltaSeconds for Surtees (4) is stated as 0.001, but the SOURCE is +0.000.; The deltaSeconds for S2 is stated as 0.000, but the SOURCE is +0.006.; The deltaSeconds for Hawthorn Bend (5) is stated as -0.001, but the SOURCE is -0.002.; The deltaSeconds for Sheene Curve (8) is stated as -0.001, but the SOURCE is -0.004.; The deltaSeconds for Stirling's Bend (9) is stated as -0.001, but the SOURCE is +0.001.; The deltaSeconds for S3 is stated as 0.001, but the SOURCE is -0.003. |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | output-shape | 0.000 | corners.1.severity: Invalid option: expected one of "minor"\|"moderate"\|"major"; corners.2.severity: Invalid option: expected one of "minor"\|"moderate"\|"major"; setup.0.component: Invalid input: expected string, received undefined; setup.0.symptom: Invalid input: expected string, received undefined; setup.0.fix: Invalid input: expected string, received undefined; setup.0.current: Invalid input: expected string, received undefined |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | corner-coverage | 0.667 | missed: Graham Hill Bend (score 0.67) |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | numeric-grounding | 0.000 | output failed to parse — cannot score grounding |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | unit-consistency | 0.000 | leaked imperial unit: "psi" |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | output-shape | 0.000 | corners.1.severity: Invalid option: expected one of "minor"\|"moderate"\|"major"; corners.2.severity: Invalid option: expected one of "minor"\|"moderate"\|"major" |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | corner-coverage | 1.000 | all 3 expected corners mentioned |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | numeric-grounding | 0.000 | output failed to parse — cannot score grounding |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | unit-consistency | 1.000 | clean |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | output-shape | 0.000 | <root>: Invalid input: expected object, received string |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | corner-coverage | 0.667 | missed: Druids (score 0.67) |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | numeric-grounding | 0.000 | output failed to parse — cannot score grounding |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | unit-consistency | 0.000 | leaked imperial unit: "psi" |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | unit-consistency | 1.000 | clean |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | correctness | 0.000 | judge flagged unsupported/contradicted claims: Paddock Hill Bend (1): The AI claims Lap B braked 28.2m later than Lap A (64m vs 39m), but 64 - 39 = 25m.; Druids (2): The AI states Lap A brake-on occurred at 585m, but the SOURCE data shows Lap A brake_on @474m.; Graham Hill Bend (3): The AI states Lap A brake_on was 797m and Lap B was 878m, but the SOURCE data shows Lap A brake_on @766m and Lap B brake_on @779m.; Cooper Straight: The AI refers to a '63m straight', but the segment range (980-1051m) indicates a length of 71m.; Surtees (4): The AI claims Lap B braked 12.9m 'later' than Lap A using the values 1189m (B) and 1204m (A). However, 1189m is earlier than 1204m, and the difference is 15m, not 12.9m.; Hawthorn Bend (5): The AI claims Lap B braked 14m 'later' than Lap A using the values 1892m (B) and 2003m (A). However, 1892m is earlier than 2003m.; Westfield Bend (6): The AI claims Lap B braked 11.4m 'later' than Lap A using the values 2296m (B) and 2339m (A). However, 2296m is earlier than 2339m.; Sheene Curve (8): The AI claims Lap B braked 13.7m 'later' than Lap A using the values 2649m (B) and 2650m (A). However, 2649m is earlier than 2650m.; Stirling's Bend (9): The AI compares Lap A's brake_on (2882m) to Lap B's brake_off (2940m) to calculate a delta, which is an invalid comparison of different telemetry events.; Clark Curve (10): The AI claims Lap B braked 11.9m 'later' than Lap A using the values 3304m (B) and 3317m (A). However, 3304m is earlier than 3317m. |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | compare-directionality | 1.000 | correct: faster = Lap B |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | unit-consistency | 1.000 | clean |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | correctness | 0.000 | judge flagged unsupported/contradicted claims: In Paddock Hill Bend (1), the AI claims Lap B had a 'significantly higher average throttle input (56.9% vs 61.5%)', but 56.9% is lower than 61.5%.; In Druids (2), the AI claims Lap B braked 29.8% at the entry compared to Lap A's 29.8%, but the source shows Lap B's average brake is 20.6%.; In Graham Hill Bend (3), the AI states the brake points are '878m vs 853m', but the source shows brake_off values of 864m and 843m respectively.; In Surtees (4), the AI claims Lap B applied 'significantly more throttle... (54.0% vs 54.5%)', but 54.0% is lower than 54.5%.; In Surtees (4), the AI claims Lap B braked '12.9% less' at the entry, but the difference between 100.0% (Lap A) and 76.5% (Lap B) is 23.5%.; In Hawthorn Bend (5), the AI claims Lap B braked '13.3% less' at entry, but Lap B's peak brake (75.6%) is actually higher than Lap A's (70.2%).; In Westfield Bend (6), the AI claims Lap B braked 'later' at 2235m compared to Lap A at 2239m, but 2235m is earlier than 2239m.; In Sheene Curve (8), the AI claims Lap B braked 'later' at 2649m compared to Lap A at 2650m, but 2649m is earlier than 2650m.; In Stirling's Bend (9), the AI claims Lap B braked 'later' at 2894m compared to Lap A at 2882m, but the source shows Lap A's peak brake is 2912m.; In Clark Curve (10), the AI claims Lap B braked 'later' at 3304m compared to Lap A at 3299m, but the source shows Lap A's peak brake is 3317m.; In Coaching Tip 1, the AI claims Lap A was 'consistently braking later' in T1, T3, T5, and T9, but the source shows Lap B braked later in T1 and T3.; In Coaching Tip 2, the AI claims Lap B 'successfully utilized the track limits' and 'applied throttle earlier' in Hawthorn (5) and Surtees (4), but the source shows full_throttle distances are identical for both laps (1051m and 1784m respectively). |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | unit-consistency | 1.000 | clean |

## Output excerpts
First successful output per model and case; complete raw outputs remain in the JSON artifact.

### prism-ml/bonsai-27b — acc-brands-hatch-2026-04-10-lap-3-analyst

```text
{
  "verdict": "Your lap averages 158.7 km/h but loses critical seconds through poor entry speed retention and excessive counter-steering at blind crests. The biggest gains come from committing earlier to inside kerbs on Hawthorn Bend and Clark Curve, while you smooth throttle modulation to eliminate the 1.9s of understeer scrub.",
  "pace": [
    {
      "label": "Avg Speed",
      "value": "158.7 km/h",
      "assessment": "good",
      "detail": "Maintains consistent mid-range velocity but is capped on exits due to excessive steering input."
    },
    {
      "label": "Throttle Avg %",
   …
```

### prism-ml/bonsai-27b — acc-brands-hatch-2026-04-10-laps-2-vs-3-compare

```text
'''json
{
  "verdict": "Lap B is slower overall due to heavier brake application and delayed throttle lift-off on multiple priority corners, particularly at Paddock Hill Bend, Surtees (4), and Clark Curve (10).",
  "segments": [
    {
      "name": "Paddock Hill Bend (1)",
      "deltaSeconds": -0.005,
      "throttle": "Lap B lifts off throttle at 64m vs Lap A's 45m, maintaining a slightly lower average input of 57%.",
      "brake": "Lap B brakes 25m later and applies peak force of 67.5% vs Lap A's 54.5%, causing a heavier blind downhill entry.",
      "steering": "Lap B uses more aggressive…
```

### qwen/qwen3.5-9b — acc-brands-hatch-2026-04-10-lap-3-analyst

```text
{
  "verdict": "Your lap time is competitive but stability issues at high-speed corners are limiting pace. Paddock Hill Bend shows consistent over-slowing due to early throttle lift, while Hawthorn Bend exhibits understeer scrub that slows you off-line. Tire temperatures reveal a significant front-left/right imbalance (92°C vs 82°C) which risks uneven degradation and grip loss.",
  "pace": [
    { "label": "Avg Speed", "value": "158.7 km/h", "assessment": "good", "detail": "Solid average speed for GT3, but consistency is lost in corners." },
    { "label": "Throttle Avg", "value": "69%", "asse…
```

### qwen/qwen3.5-9b — acc-brands-hatch-2026-04-10-laps-2-vs-3-compare

```text
{
  "verdict": "Lap B is faster due to consistent trail braking and later exit speed maintenance, whereas Lap A brakes earlier with aggressive lift-off points that kill corner rotation, particularly on Surtees, Hawthorn, and Clark Curve.",
  "segments": [
    {
      "name": "Paddock Hill Bend (1)",
      "deltaSeconds": 0.006,
      "throttle": "Lap A averages higher throttle (61.5% vs 56.9%) and reaches full throttle earlier at the apex entry.",
      "brake": "Driver A applies brakes 25m earlier than Lap B (39m vs 64m) with a significantly lower peak brake pressure of 54.5% compared to B's …
```

### qwen3.8-27b — acc-brands-hatch-2026-04-10-lap-3-analyst

```text
{
  "verdict": "A valid lap at 1:28.070 with strong pace (avg speed 158.7 km/h) but significant time losses from over-brading and counter-steer under trail-brading. The biggest gains are in reducing front brake bias to reduce understeer scrub, smoothing throttle application (binary throttle at 81%), and addressing the asymmetric tyre temps (FL vs FR = 10°).",
  "pace": [
    { "label": "Throttle Average", "value": "69%", "assessment": "warning", "detail": "Average throttle of 69% with 59% full-throttle time indicates decent pace but binary application (81% full-on/full-off) causes over-brading…
```

### qwen3.8-27b — acc-brands-hatch-2026-04-10-laps-2-vs-3-compare

```text
{
  "verdict": "Lap A (90.362s) vs Lap B (88.070s): Both laps are nearly identical in throttle, brake, and steering inputs across all segments, with differences of 0.000-0.002 seconds per segment. The primary distinction is that Lap B applies slightly more aggressive braking peaks (e.g., 100% vs 93.7% at Druids) while maintaining comparable exit speeds, indicating a marginally tighter brake application without sacrificing momentum.",
  "segments": [
    {
      "name": "Paddock Hill Bend (1)",
      "deltaSeconds": 0.000,
      "throttle": "Both laps reach full throttle at segment start; A lif…
```

### google/gemma-4-e2b — acc-brands-hatch-2026-04-10-lap-3-analyst

```text
{
  "verdict": "You demonstrated solid pace but significant time was lost due to inconsistent braking points and instability in high-load corners, particularly concerning counter-steer and over-slowed cornering. The biggest gains will come from refining your entry speed management into Paddock Hill Bend (1) and optimizing the throttle application out of Hawthorn Bend (5).",
  "pace": [
    {
      "label": "Average Speed",
      "value": "158.7 km/h",
      "assessment": "good",
      "detail": "The average speed is acceptable, but the variance suggests inconsistent application of braking and …
```

### google/gemma-4-e2b — acc-brands-hatch-2026-04-10-laps-2-vs-3-compare

```text
'''json
{
  "verdict": "Lap B demonstrated superior execution across several high-demand corners, particularly in braking zones and momentum management through the middle sector of the track.",
  "segments": [
    {
      "name": "Paddock Hill Bend (1)",
      "deltaSeconds": 0.011,
      "throttle": "Lap B maintained a slightly lower average throttle percentage (56.9% vs 61.5%) throughout the corner entry.",
      "brake": "Lap B braked 28.2m later into the corner than Lap A (64m vs 39m).",
      "steering": "Lap B showed a smoother steering input, aiming for a slightly later apex point relat…
```

## Failures

| Model | Case | Repeat | Stage | Message |
|---|---|---:|---|---|
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | generation | The operation timed out. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | generation | The operation timed out. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | generation | The operation timed out. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | generation | The operation timed out. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | scoring | Scorer Run Failed: The operation timed out. |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | scoring | Scorer Run Failed: The operation timed out. |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | scoring | Scorer Run Failed: The operation timed out. |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | scoring | Scorer Run Failed: The operation timed out. |
| google/gemma-4-e2b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | scoring | Scorer Run Failed: The operation timed out. |
