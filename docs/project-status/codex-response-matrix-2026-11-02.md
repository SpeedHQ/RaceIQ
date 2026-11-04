# Codex response and usage matrix — 2026-11-02

Purpose: sample real RaceIQ routes, keep short examples, and report actual
token/latency diagnostics. Runs used authenticated Codex CLI 0.164.0 and
ChatGPT-managed `gpt-6-luna` unless noted. Public Lusail telemetry came from the
committed F1 25 fixture. Driver Coach and Setup Engineer examples used
synthetic reports/setups. No private relay capture went to Codex.

## Route samples

| Route / example | Input tokens | Cached input | Output tokens | Reasoning tokens | First content | Turn time | Requested / effective output cap |
|---|---:|---:|---:|---:|---:|---:|---|
| Lap Analyst — Lusail 86.709 s | 13,371 | 0 | 1,821 | 276 | 3.994 s | 14.919 s | 32,768 / unsupported, unknown |
| Lap Analyst — Lusail 90.704 s | 13,471 | 0 | 1,919 | 181 | 3.436 s | 14.715 s | 32,768 / unsupported, unknown |
| Comparison chat — 86.709 s vs 90.704 s | 13,194 | 12,928 | 145 | 0 | 5.637 s | 6.875 s | 32,768 / unsupported, unknown |
| Driver Coach — propose T4 drill | 7,797 | 0 | 109 | 0 | 1.600 s | 2.604 s | 32,768 / unsupported, unknown |
| Driver Coach — confirmed drill | 8,091 | 7,808 | 85 | 0 | 2.823 s | 3.476 s | 32,768 / unsupported, unknown |
| Driver Coach — duplicate delivery | 8,066 | 7,808 | 77 | 0 | 3.114 s | 3.881 s | 32,768 / unsupported, unknown |
| Setup Engineer — synthetic F1 setup smoke | 9,743 | not retained | 63 | unknown | 4.607 s | 5.162 s | 8,192 / unsupported, unknown |
| Lap chat — synthetic lap/tool smoke | 4,315 | not retained | 14 | unknown | 2.037 s | 2.162 s | 8,192 / unsupported, unknown |
| Inputs comparison — public Lusail laps, `gpt-6.1-sol` | 20,056 | 0 | 3,465 | 219 | 10.9 s | 58.5 s | 8,192 / unsupported, unknown |

Costs remain unknown. Durations are runtime/provider diagnostics, not billing
estimates. All route completions above finished without a truncation/error
signal. All six analyst responses passed production schema validation. The
inputs comparison passed its output schema and cache identity
checks. Chat responses are text, so this snapshot uses manual evidence checks,
not a formal quality score.

## Short output examples

**Lap Analyst:** “Your three timed sectors total 86.709 s … the clearest driving
opportunities [are] T1 and T16.” It also warned against emptying ERS in a race.

**Comparison chat:** “Lap A is faster: 86.709s vs 90.704s, by 3.995s.” It
identified T3’s 3.327 s loss on B, warned that the 0 km/h minimum may be a
telemetry/corner-assignment anomaly, and recommended keeping B’s full-throttle
commitment through T9, T11 and T12.

**Driver Coach proposal:** “Brake at the 110 m board instead of 120 m” while
holding brake pressure and release steady. It explicitly said no telemetry was
available and asked for approval before recording.

**Driver Coach after approval:** “Recorded as v1.1 — Brake 10m later into T4.”
The route created one `drill` version, with no setup file/snapshot. Replaying
the same confirmed message ID returned the existing result; version count and
head stayed unchanged.

**Setup Engineer:** authenticated route smoke applied Front Wing 20 → 21 after
the driver confirmed the proposed change. The run used synthetic setup data.

## Repeated samples

Three identical route runs per case, fixed model (`gpt-6-luna`), fixed prompt,
fixed fixture, medium effort, requested output value 32,768. Codex did not
enforce that output value. Values below show observed run-to-run range and
median; they measure natural output variance, not budget effects.

| Case | Input tokens | Output tokens | Reasoning tokens | First content | Completion |
|---|---:|---:|---:|---:|---:|
| Lap Analyst — Lusail 86.709 s | 13,371 each | 1,506–1,821; median 1,608 | 208–276 | 3.559–3.994 s; median 3.856 s | 12.104–14.919 s; median 14.561 s |
| Lap Analyst — Lusail 90.704 s | 13,469–13,471 | 1,543–1,919; median 1,680 | 0–272 | 1.906–3.560 s; median 3.436 s | 12.763–14.715 s; median 13.006 s |
| Comparison chat — Lusail pair | 12,765–12,773 | 110–147; median 134 | 0 | 2.423–4.218 s; median 4.029 s | 3.355–4.953 s; median 4.873 s |

Cached input varied across repetitions (analyst: 0–8,064 / 0; comparison chat:
5,760–12,544). Cost remained unknown. Analyst outputs passed the production
schema each time. Chat runs consistently picked Lap A as faster and T3 as
largest loss, while giving Lap B’s T9/T11/T12 throttle commitment as a strength.
One separate initial comparison reply said the displayed lap-time gap was
3.999 s; the displayed values 86.709 and 90.704 differ by 3.995 s. All three
repeats returned 3.995 s. This is a small but concrete numeric-consistency miss.

## What this matrix establishes

- Real authenticated route breadth: analysis, comparison chat, lap chat,
  Setup Engineer and Driver Coach. The latest comparison-chat route read public
  fixture analyses, streamed a reply, and persisted user/assistant history.
- `record_drill` proposal/approval guard and duplicate-delivery idempotency work
  through the real experiment-chat route, not only a domain-tool test.
- Token consumption varies by route: short chat replies used 14–147 output
  tokens; structured analysis/comparison used 1,506–3,465. Longer output alone
  does not imply higher quality.
- Output budgets are diagnostic values only for Codex. Runtime reported
  `supported: false` and `effectiveOutputTokens: null`; 8,192 and 32,768 were
  never enforced. No budget-tier quality claim is possible from these runs.
- Repeated samples cover two analyst cases and comparison chat. Lap chat, Setup
  Engineer and Driver Coach have route examples, but not three quality
  repetitions. 2026 telemetry was not submitted, and no deterministic quality
  score exists for these exact public Lusail samples. A full repeated study
  still needs setup and multi-turn cases plus a 2026 reference fixture. Codex
  output allowance cannot be varied; do not simulate caps.
