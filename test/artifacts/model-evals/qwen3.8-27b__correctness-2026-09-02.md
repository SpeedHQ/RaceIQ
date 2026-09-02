# OSS Model Evaluation

## Executive summary
- Dataset: **ACC Brands Hatch fixture** (acc, metric; analyst lap 3; compare laps 2 vs 3)
- Generated: `2026-09-02T12:30:16.644Z`
- Endpoint: `http://localhost:1234/v1`
- Repeats: **3 per case**
- Correctness judge: **google/gemma-4-12b-qat**
- Recommendation scope: this dataset and prompt contract only.

### Recommendation
**No recommendation.** At least one complete model with a valid quality score is required.

## Authoritative telemetry truth
Truth is generated from parsed packets and curated geometry, independent of model output. Full truth objects are embedded in the JSON artifact.

- **acc-brands-hatch-2026-04-10-lap-3-analyst** — lap 3 (88.070 s), 13 segments, slowest corners are fixture-derived
- **acc-brands-hatch-2026-04-10-laps-2-vs-3-compare** — faster lap: B, 9 corner deltas

## Model comparison

Quality ranking uses macro average of Analyst and Compare scores. Latency and throughput are reported for diagnosis, not ranking.

| Rank | Model | Status | Overall | Analyst | Compare | Correctness | Pass rate | Mean latency | Input tok | Output tok | Thinking tok | Total tok | tok/s |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| N/A | qwen3.8-27b | incomplete | 0.456 | 0.578 | 0.333 | 0.000 | 50.0% | 264850 ms | 6771.000 | 9562.667 | 7025.333 | 16333.667 | 62.471 |

## Scorer breakdown
Each scorer is averaged across repeats. Reasons are retained below in case evidence.

| Model | Scorer | Mean | Population SD | Passed | Total |
|---|---|---:|---:|---:|---:|
| qwen3.8-27b | output-shape | 1.000 | 0.000 | 1 | 1 |
| qwen3.8-27b | corner-coverage | 0.000 | 0.000 | 0 | 1 |
| qwen3.8-27b | numeric-grounding | 0.889 | 0.000 | 1 | 1 |
| qwen3.8-27b | unit-consistency | 1.000 | 0.000 | 1 | 1 |
| qwen3.8-27b | correctness | 0.000 | 0.000 | 0 | 1 |
| qwen3.8-27b | compare-directionality | 0.000 | 0.000 | 0 | 1 |
| qwen3.8-27b | unit-consistency | 1.000 | 0.000 | 1 | 1 |
| qwen3.8-27b | correctness | 0.000 | 0.000 | 0 | 1 |

## Case evidence

| Model | Case | Repeat | Scorer | Score | Reason |
|---|---|---:|---|---:|---|
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | output-shape | 1.000 | valid |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | corner-coverage | 0.000 | missed: Druids, Graham Hill Bend, Surtees (score 0.00) |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | numeric-grounding | 0.889 | 14 analysis entries checked (score 0.89) |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | unit-consistency | 1.000 | clean |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 2 | correctness | 0.000 | judge flagged unsupported/contradicted claims: The response uses the term 'over-brading' and 'trail-brading' repeatedly, which are not real racing terms and appear to be hallucinations or typos for 'over-braking' and 'trail-braking'.; The response includes a 'Brake Bias (Front)' entry in the 'handling' section with a 'warning' assessment, but the schema for 'handling' does not include a 'value' field for the 'assessment' key in the way it was structured, and it also fails to follow the 'specific number/stat' requirement for the 'value' field in that specific object.; The response includes a 'Brake Bias (Front)' entry in the 'handling' section, but the prompt instructions for 'setup' require specific formatting for setup changes (Parameter, Current, Change to, Purpose), which the response failed to use for the brake bias advice in the handling section.; The response mentions 'Surties (4)' in the corners section, but the correct name from the source is 'Surtees (4)'.; The response mentions 'over-brading' as a reason for time loss, which is not a concept provided in the source telemetry or track guide.; The response provides a 'Brake Bias' value of '75%' in the handling section but does not provide a 'value' field for the 'assessment' key, violating the JSON schema provided in the prompt. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | compare-directionality | 0.000 | model did not clearly identify a faster lap |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | unit-consistency | 1.000 | clean |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | correctness | 0.000 | judge flagged unsupported/contradicted claims: The verdict claims differences of 0.000-0.002 seconds per segment, but the SOURCE shows differences as high as +0.011s (Druids) and +0.006s (S2).; The deltaSeconds for Paddock Hill Bend (1) is stated as 0.000, but the SOURCE is -0.001.; The deltaSeconds for Druids (2) is stated as 0.000, but the SOURCE is +0.011.; The deltaSeconds for Graham Hill Bend (3) is stated as 0.002, but the SOURCE is -0.003.; The deltaSeconds for Cooper Straight is stated as -0.001, but the SOURCE is +0.000.; The deltaSeconds for Surtees (4) is stated as 0.001, but the SOURCE is +0.000.; The deltaSeconds for S2 is stated as 0.000, but the SOURCE is +0.006.; The deltaSeconds for Hawthorn Bend (5) is stated as -0.001, but the SOURCE is -0.002.; The deltaSeconds for Sheene Curve (8) is stated as -0.001, but the SOURCE is -0.004.; The deltaSeconds for Stirling's Bend (9) is stated as -0.001, but the SOURCE is +0.001.; The deltaSeconds for S3 is stated as 0.001, but the SOURCE is -0.003. |

## Output excerpts
First successful output per model and case; complete raw outputs remain in the JSON artifact.

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

## Failures

| Model | Case | Repeat | Stage | Message |
|---|---|---:|---|---|
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 1 | generation | The operation timed out. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-lap-3-analyst | 3 | generation | The operation timed out. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 1 | generation | The operation timed out. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 2 | generation | The operation timed out. |
| qwen3.8-27b | acc-brands-hatch-2026-04-10-laps-2-vs-3-compare | 3 | scoring | Scorer Run Failed: The operation timed out. |
