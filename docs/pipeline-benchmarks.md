# Pipeline Benchmarks

Location: `test/benchmarks/pipeline.bench.ts`
Run: `bun run test/benchmarks/pipeline.bench.ts`
Output: `bench-results.json` (~20KB)

Measures parse + full-pipeline throughput for FM 2023, F1 2025, and ACC using recorded UDP dumps with `NullDbAdapter` / `NullWsAdapter` (no I/O).

## Why this file patches mitata

Running an earlier version of the bench locked up at the ACC group or ran for 3–5 minutes with no apparent progress. Investigation found **three independent issues stacked on top of each other**, each needing its own fix.

### 1. Fire-and-forget async starves mitata's scheduler

Early benches used:

```ts
bench("pipeline", () => { void pipeline.processPacket(packet); });
```

`processPacket` is `async` and awaits the lap detector, which queues microtasks. The bench body returns immediately — mitata thinks it's a 200ns sync bench and drives it at millions of iters/sec. Each iter enqueues a Promise chain. Microtasks drain exhaustively between macrotasks, so mitata's timer-based scheduler never advances. Result: intermittent true hang, often mid-F1 pipeline bench, before ACC ever starts.

**Fix:** make the bench actually async so mitata measures (and awaits) the real cost:

```ts
bench("pipeline", async () => { await pipeline.processPacket(packet); });
```

### 2. Lap-detector log spam masquerading as a hang

When a bench cycles the same 1000 packets repeatedly, every wrap from `packets[999]` back to `packets[0]` looks like a session reset to `server/lap-detector.ts`:

- `[Session] New session: distance-reset` (line 254)
- `[Lap] Race restart detected — discarding buffer` (line 178)
- `[Lap] Rewind: timestamp X -> Y. Marking lap invalid.` (line 190)

Under the old uncapped mitata defaults, FM + F1 pipeline benches produced **~965,000 lines of log spam** before completing. After the spam ended, ACC (which uses `LapDetectorV2` — no console logging) ran silently for another ~2 minutes. The visible terminal freeze after the spam stopped looked exactly like an ACC hang, which is why the symptom was misfiled.

**Context:** the spam isn't the root cause of the hang — issue (3) below is — but it was the source of the *perception* that ACC specifically was broken.

### 3. `run()` options don't forward to measurement

Mitata's public API suggests `run({ min_cpu_time, min_samples, max_samples, batch_samples })` controls iteration count. **It does not.** Reading `node_modules/mitata/src/main.mjs`:

- `run(opts)` only uses `opts.filter`, `opts.throw`, `opts.format`, `opts.observe`, `opts.print`, `opts.colors`.
- For each bench, it calls `trial.run(opts.throw)` — passing only the throw flag.
- `B.prototype.run()` (line 111) builds a hardcoded `tune` object with `gc`, `inner_gc`, `heap`, `$counters` and calls `measure(this.f, tune)`.
- Defaults live in `lib.mjs` as `const`: `k_min_cpu_time = 642 * 1e6` (642ms), `k_batch_samples = 4096`, `k_max_samples = 1e9`.

For a ~60µs/iter async bench, 642ms × 6 benches = ~4s of pure sampling, but warmup + calibration + Promise-chain overhead balloons each bench into 20–30s. Total runtime ≈180s. The `bench-results.json` included the full `samples` array for each bench → ~34MB file.

**Fix:** monkey-patch `B.prototype.run` to call `measure()` directly with our caps merged into `tune`:

```ts
import { B } from "mitata/src/main.mjs";

const BENCH_OPTS = {
  min_samples: 10,
  max_samples: 30,
  batch_samples: 10,
  min_cpu_time: 50_000_000, // 50ms in ns
};

B.prototype.run = async function (thrw = false) {
  const tune = { /* gc/heap/counters as in upstream */, ...BENCH_OPTS };
  const stats = await measure(this.f, tune);
  return { /* upstream result shape */ };
};
```

The patched version also strips the `samples` / `ticks` arrays from results before writing:

```ts
const slim = JSON.parse(JSON.stringify(results), (k, v) =>
  (k === "samples" || k === "ticks" ? undefined : v));
await Bun.write("bench-results.json", JSON.stringify(slim, null, 2));
```

## Results after all three fixes

| Metric              | Before | After  |
|---------------------|--------|--------|
| Total run time      | 180s (or infinite hang) | 4.4s |
| `bench-results.json`| 34MB   | 20KB   |
| Intermittent hang   | Yes    | No     |

## Perf findings surfaced by the bench

With the harness working, the numbers pointed at two real issues in production code:

### `broadcastDevState` allocates every packet

`Pipeline.processPacket` built a fresh debug-state object tree (lap detector
+ sector tracker + pit tracker) every call and sent it to the WebSocket
adapter, even with no dev clients connected. Added a `skipDevState` option
to the Pipeline constructor; the bench passes `skipDevState: true`. Minor
win for FM/F1 (dev state wasn't their dominant allocator), meaningful
cleanup for ACC. In production this should be gated on whether any client
has the dev tab open.

### Bundled centerline CSVs were read from disk every 6 packets

Biggest win. Track calibration runs every 6 packets and calls
`getTrackOutlineByOrdinal` → `loadBundledCenterline`, which did
`readFileSync` + parse of a ~1000-line CSV into ~1000 Point objects **on
every invocation**. No memoization. That meant every running game session
did ~10 sync disk reads per second forever, and allocated ~58 kb per call.

Fix: module-level `Map<key, Point[] | null>` in `shared/track-data.ts`
keyed by `(gameId, ordinal)`. Bundled centerline files are static, so the
cache is safe. Recorded and shared outlines (which can change at runtime)
are still loaded fresh.

| Game | pipeline µs/iter | pipeline alloc/iter |
|------|------------------|---------------------|
| FM   | 60.24 → 5.03 (12×)  | 11.84 kb → 327 b (36×) |
| F1   | 25.69 → 2.24 (11×)  |  6.83 kb → 163 b (41×) |
| ACC  |  2.17 → 2.21 (same) |     54 b → 163 b (same) |

ACC doesn't hit the calibration path (`adapter.coordSystem === "standard-xyz"`
skips it), so no change there.

## Maintenance notes

- The `B.prototype.run` override currently handles the static-args case only. If a future bench uses `.args()` / `.range()` for parametric sweeps, extend the patch to handle the `kind !== "static"` branch in upstream `main.mjs`.
- If mitata ships a release that properly forwards `run()` options to `measure()`, the monkey-patch can be deleted in favor of passing options to `run()` directly.
- `BENCH_OPTS` is tuned for stable numbers at ~4s total. Raise `min_cpu_time` or `max_samples` for tighter confidence intervals at the cost of runtime.
