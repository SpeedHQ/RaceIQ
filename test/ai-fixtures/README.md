# AI Eval Fixtures

Curated lap fixtures for `test/ai-quality.test.ts`. Each fixture JSON
describes a real lap (or lap pair) plus the _expected signals_ the scorers
check against.

## Structure

```
laps/                         solo-lap fixtures → Lap Analyst + Lap Chat evals
compare-pairs/                paired-lap fixtures → Compare Engineer + Compare Chat evals
packets/                      zip files produced via `bun run laps:export`
baselines/                    per-SHA score snapshots (see scripts/ai-baseline.ts)
```

## Adding a fixture

1. In the running RaceIQ dev DB, identify a lap with a clear, well-known
   characteristic (tire overheat, understeer at high speed, traction loss
   on exit, etc.). Note its `id`.
2. Export the lap:
   ```
   bun run laps:export --ids <id> -o test/ai-fixtures/packets/<fixture-id>.zip
   ```
3. Create `laps/<fixture-id>.json` referencing the zip via `packetsPath`.
4. Hand-curate the `expected` block — **signals only**, not a full reference
   answer. Signals survive prompt iteration; reference answers do not.
5. Confirm the scorers catch what you care about:
   ```
   bun run test:ai
   ```

## Why "signals, not reference answers"

The model's exact wording will drift every time the prompt or model changes.
If fixtures pinned full answers, every prompt tweak would churn the
fixtures. Signals (`slowestCorners`, `fasterLap`, `setupDirection`) are what
we actually care about being correct, and they stay stable across rewrites.
