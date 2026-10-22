import { mkdtemp, mkdir, open, readFile, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { decompressIfGzipSync, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { WorkerSessionRecorder } from "@raceiq/capture-formats/session/worker-recorder";
import { LatencyHistogram, NativeRecordDigest } from "./live-lossless-metrics";

const ROOT = resolve(import.meta.dir, "../../../..");
// Bun hrtime origins differ across workers. Translate performance's monotonic
// clocks to their shared epoch; double precision limits resolution to ~0.3 µs.
const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
const options = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)=(.+)$/.exec(arg);
  if (!match || options.has(match[1]!)) throw new Error(`Expected unique --name=value option: ${arg}`);
  options.set(match[1]!, match[2]!);
}
for (const key of options.keys()) {
  if (!["output", "seconds", "fps", "trials", "child"].includes(key)) throw new Error(`Unknown option --${key}`);
}
function integer(name: string, fallback: number, max: number): number {
  const value = Number(options.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be an integer from 1 to ${max}`);
  return value;
}
const seconds = integer("seconds", 30, 3600);
const fps = integer("fps", 240, 100000);
const trials = integer("trials", 3, 20);
const child = options.get("child");
if (child && child !== "baseline" && child !== "worker") throw new Error("--child must be baseline or worker");
const output = options.get("output");
if (!output) throw new Error("--output=<path> is required");

async function trial(mode: "baseline" | "worker") {
  // Bounded fixture working set, identical in fresh processes. Input repetition
  // tests recorder transport, not detector behavior or real game-rate coverage.
  const fixture = join(ROOT, "test/artifacts/sessions/fm-2023-with-pitting.bin.gz");
  const frames: Buffer[] = [];
  {
    const source = decompressIfGzipSync(await readFile(fixture));
    for (const record of iterateSessionCaptureRecords(source, 0, { strict: true })) {
      if (record.kind === "frame") frames.push(Buffer.from(record.frame));
      if (frames.length === 512) break;
    }
  }
  if (!frames.length) throw new Error("FM fixture has no native frames");
  Bun.gc(true);
  const root = await mkdtemp(join(tmpdir(), "raceiq-recorder-handoff-"));
  const path = join(root, "capture.bin");
  const enqueue = new LatencyHistogram(), received = new LatencyHistogram();
  const written = new LatencyHistogram(), durable = new LatencyHistogram();
  const batchRecords = new LatencyHistogram();
  const pending = new Map<number, bigint>();
  const expected = new NativeRecordDigest();
  const rssStart = process.memoryUsage().rss;
  let peakRss = rssStart, peakInFlight = 0, peakBatch = 0, peakPending = 0;
  let batches = 0, transferredBytes = 0, writtenSequence = 0, durableSequence = 0;
  let receivedSequence = 0, failure: Error | undefined;
  const windows = Array.from({ length: 12 }, () => ({ min: Infinity, max: 0 }));
  const started = performance.now();
  const worker = mode === "worker" ? new Worker(new URL("./recorder-handoff-worker.ts", import.meta.url), { workerData: { syncIntervalMs: 1000 } }) : null;
  const recorder = worker
    ? new WorkerSessionRecorder("fm-2023", { worker, maxInFlightBytes: 16 * 1024 * 1024, maxBatchBytes: 4 * 1024 * 1024 })
    : new SparseSessionRecorder("fm-2023");
  function recordThrough(histogram: LatencyHistogram, first: number, last: number, now: bigint) {
    for (let sequence = first; sequence <= last; sequence++) {
      const sent = pending.get(sequence);
      if (sent === undefined) throw new Error(`Missing timestamp for sequence ${sequence}`);
      const ns = Number(now - sent);
      if (ns < 0) throw new Error("Worker and producer clocks are not comparable");
      histogram.record(ns);
    }
  }
  worker?.on("error", (error) => { failure = error instanceof Error ? error : new Error(String(error)); });
  worker?.on("message", (message: { type: string; sequence?: number; firstSequence?: number; lastSequence?: number; receivedNs?: bigint; records?: number; transferredBytes?: number; error?: string }) => {
    try {
      if (message.type === "benchmark-received") {
        if (message.firstSequence !== receivedSequence + 1 || message.lastSequence === undefined || message.receivedNs === undefined) throw new Error("Receipt sequence gap");
        recordThrough(received, message.firstSequence, message.lastSequence, message.receivedNs);
        receivedSequence = message.lastSequence;
        batches++;
        transferredBytes += message.transferredBytes!;
        // Reuse the bounded histogram for integer batch counts, without time units.
        batchRecords.record(message.records! * 1e6);
      } else if (message.type === "ack" && message.sequence !== undefined) {
        recordThrough(written, writtenSequence + 1, message.sequence, nowNs());
        writtenSequence = message.sequence;
      } else if (message.type === "durable" && message.sequence !== undefined) {
        recordThrough(durable, durableSequence + 1, message.sequence, nowNs());
        for (let sequence = durableSequence + 1; sequence <= message.sequence; sequence++) pending.delete(sequence);
        durableSequence = message.sequence;
      } else if (message.type === "failed") failure = new Error(message.error ?? "Worker failed");
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
  });
  const sample = () => {
    const rss = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rss);
    const window = windows[Math.min(11, Math.floor((performance.now() - started) / (seconds * 1000) * 12))]!;
    window.min = Math.min(window.min, rss);
    window.max = Math.max(window.max, rss);
    if (recorder instanceof WorkerSessionRecorder) {
      peakInFlight = Math.max(peakInFlight, recorder.inFlightByteCount);
      peakBatch = Math.max(peakBatch, recorder.pendingBatchByteCount);
    }
    peakPending = Math.max(peakPending, pending.size);
  };
  const sampler = setInterval(sample, 10);
  try {
    recorder.start(path);
    recorder.writeMetaFrame();
    const total = seconds * fps;
    const pacingStart = performance.now();
    let emitted = 0;
    while (emitted < total) {
      // Deadline pacing never skips records or waits for worker capacity. Bound
      // each turn to 256 records so bursts cannot hide event-loop starvation.
      const due = Math.min(total, Math.floor((performance.now() - pacingStart) * fps / 1000) + 1);
      const end = Math.min(due, emitted + 256);
      for (; emitted < end; emitted++) {
        if (failure) throw failure;
        const frame = frames[emitted % frames.length]!;
        const timestamp = emitted % 3 === 0 ? undefined : emitted % 3 === 1 ? 0 : 1700000000000 + emitted;
        const before = nowNs();
        if (worker) pending.set(emitted + 1, before);
        recorder.writeRecord(frame, timestamp);
        enqueue.record(Number(nowNs() - before));
        expected.add(frame, timestamp);
      }
      sample();
      await Bun.sleep(Math.max(0, Math.min(5, (emitted + 1) * 1000 / fps - (performance.now() - pacingStart))));
    }
    const closeStarted = performance.now();
    await recorder.stop();
    if (!worker) {
      // Baseline stop patches the header but does not fsync. Include one final
      // fsync here so both reported close times end with a durable source.
      const handle = await open(path, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const closeMs = performance.now() - closeStarted;
    sample();
    clearInterval(sampler);
    if (failure) throw failure;
    if (worker && (receivedSequence !== total || writtenSequence !== total || durableSequence !== total || pending.size)) throw new Error("Worker did not receive, write, and durably acknowledge every accepted record");
    const memory = { rssStartBytes: rssStart, sampledPeakRssBytes: peakRss, sampledGrowthBytes: peakRss - rssStart,
      lifetimePeakRssBytesBeforeVerification: process.resourceUsage().maxRSS * 1024,
      windows: windows.map((window) => window.max ? window : null),
      peakInFlightBytes: peakInFlight, peakPendingBatchBytes: peakBatch, peakDiagnosticTimestamps: peakPending };
    // Verification stays outside the timed/RSS capture interval.
    const actual = new NativeRecordDigest();
    for (const record of iterateSessionCaptureRecords(await readFile(path), 0, { strict: true })) {
      if (record.kind === "frame") actual.add(record.frame, record.frameTimeMs);
    }
    if (actual.count !== total || actual.digest() !== expected.digest()) throw new Error("Persisted native bytes/order/timestamp presence mismatch");
    return { mode, records: total, nativeBytes: actual.bytes, verifiedNativeDigest: actual.digest(), closeMs,
      memory, enqueueMs: enqueue.snapshot(), enqueueToWorkerReceiptMs: worker ? received.snapshot() : null,
      enqueueToWriteAckMs: worker ? written.snapshot() : null, enqueueToDurableAckMs: worker ? durable.snapshot() : null,
      batches, transferredBytes, recordsPerBatch: worker ? batchRecords.snapshot() : null };
  } finally {
    clearInterval(sampler);
    await recorder.stop().catch(() => {});
    if (worker) await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
}

await mkdir(dirname(resolve(output)), { recursive: true });
if (child) {
  await Bun.write(output, JSON.stringify(await trial(child === "worker" ? "worker" : "baseline"), null, 2));
} else {
  const root = await mkdtemp(join(tmpdir(), "raceiq-handoff-results-"));
  try {
    const results = [];
    for (let run = 0; run < trials; run++) {
      // Alternate order to reduce systematic warm-cache/order bias. Every variant
      // still gets a fresh process; no reused process high-water comparison.
      for (const mode of run % 2 ? ["worker", "baseline"] : ["baseline", "worker"]) {
        const resultPath = join(root, `${run}-${mode}.json`);
        const process = Bun.spawn([Bun.which("bun")!, import.meta.filename, `--child=${mode}`, `--seconds=${seconds}`, `--fps=${fps}`, `--output=${resultPath}`], { stdout: "inherit", stderr: "inherit" });
        if (await process.exited !== 0) throw new Error(`${mode} trial ${run} failed; no performance acceptance implied`);
        results.push({ trial: run, ...JSON.parse(await readFile(resultPath, "utf8")) });
      }
    }
    const report = { benchmark: "source-recorder-memory-handoff", completedAt: new Date().toISOString(),
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }, seconds, fps, trials,
      limitations: "Worker receipt is timestamped using performance.timeOrigin + performance.now() on both threads before queued filesystem work; absolute clock conversion has approximately 0.3 microsecond resolution. Write/durable acknowledgements include return delivery delay. One diagnostic reply per batch and bounded pending timestamp bookkeeping add overhead. RSS includes worker, fixture, diagnostics, and runtime. Lifetime peak includes fixture preparation; sampled capture peak excludes final verification. OS caches uncontrolled; baseline lacks periodic fsync. No copy/allocation counts inferred from transferred bytes. Memory windows are observations, not a leak verdict.",
      scope: "Real sparse source recorder and filesystem worker; repeated first 512 native FM fixture frames, synthetic missing/zero/UTC timestamps. Not full lap derivation, real game-rate coverage, or release approval.",
      results };
    await Bun.write(output, JSON.stringify(report, null, 2));
    console.log(`Verified ${results.length} isolated recorder trials; memory/handoff report: ${resolve(output)}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}
