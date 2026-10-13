import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";

const ROOT = resolve(import.meta.dir, "../../../../");
const CHILD = resolve(import.meta.dir, "dashboard-contention-child.ts");
const DEFAULT_FIXTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const MiB = 1024 * 1024;
type Mode = "small" | "baseline" | "enabled" | "finalization";
type ChildEvent = Record<string, unknown> & { event: string };
type WireExpectation = { count: number; bytes: number; digest: string; durationMs: number; packetHz: number };
type ScenarioResult = {
  diagnosticOutput?: string;
  event: "done"; mode: Mode; sentDatagrams: number;
  requestOnly: { count: number; p50Ms: number | null; p95Ms: number | null; maxPayloadBytes: number; idleRssBytes: number; peakRssBytes: number; incrementalRssBytes: number; baselineTotalLaps: number | null; byScope: Array<{ scopeKey: string; count: number; p95Ms: number | null }> };
  concurrentRequests: { count: number; p50Ms: number | null; p95Ms: number | null; maxPayloadBytes: number; idleRssBytes: number; peakRssBytes: number; incrementalRssBytes: number; byScope: Array<{ scopeKey: string; count: number; p95Ms: number | null }> };
  liveVisibility: { persistedWrites: number; visibleWrites: number; maxDelayMs: number | null; delaysMs: number[] };
  finalFields: { status: string; sessionId: number | null; elapsedMs?: number; reason?: string; revision?: number; durationStatus?: string; durationElapsedSeconds?: number | null; weatherStatus?: string; sectorStatus?: string; recapFieldsMatched?: boolean };
  metadataCompleteResponses: { count: number; allTrue: boolean };
  recordedWire: { count: number; bytes: number; digest: string };
  replayTiming: { actualDurationMs: number; actualPacketHz: number | null };
  decodePublicationOrdering: { observedDashboardPublicationCommits: number; commitsWhileCaptureReadOpen: number; maxCaptureStreamsAtPublication: number; scope: string; structuralOrder: string };
  rssTrajectory: { sampleCount: number; samplingIntervalMs: number; overflow: boolean; phases: Array<{ targetFraction: number; observedFraction: number; elapsedMs: number; rssBytes: number }>; midToTailGrowthBytes: number };
  capture: { sessionCount: number; sessionIds: number[]; maxConcurrentStreams: number };
  persistence: { lapCount: number; duplicateLaps: number; lapIdentityDigest: string; writeCount: number; writeOverflow: number; liveLapWriteOverflow: number; writeP95Ms: number | null };
  backfill: { dirtyRows: number; drained: boolean | null; seededCaptureDirtyRows: { beforeWorkload: number; atReplayEnd: number; clearedDuringReplay: number; afterRecording: number; afterDrain: number } };
  resources: { workloadIdleRssBytes: number; workloadPeakRssBytes: number; workloadIncrementalRssBytes: number; samplingIntervalMs: number; scope: string };
  fixture: { lapCount: number; sessionCount: number; metadataOnlyPublished: number; metadata: unknown };
};

function cliArgs(argv: string[]): Record<string, string> {
  return Object.fromEntries(argv.filter((item) => item.startsWith("--")).map((item) => {
    const [key, ...value] = item.slice(2).split("=");
    return [key!, value.join("=")];
  }));
}

function sourceWireExpectation(path: string): WireExpectation {
  const packets = readUdpDump(path);
  const hash = createHash("sha256"), length = Buffer.allocUnsafe(4);
  let bytes = 0, durationMs = 0, previousTime: number | null = null;
  for (const packet of packets) {
    length.writeUInt32LE(packet.length);
    hash.update(length);
    hash.update(packet);
    bytes += packet.length;
    if (packet.length < 8) continue;
    const timestamp = packet.readUInt32LE(4);
    if (previousTime !== null) {
      let delta = timestamp - previousTime;
      if (delta < 0) {
        if (previousTime > 0xf000_0000 && timestamp < 0x0fff_ffff) delta += 0x1_0000_0000;
        else delta = 0;
      }
      if (delta > 0) durationMs += delta;
    }
    previousTime = timestamp;
  }
  if (durationMs <= 0 || packets.length < 2) throw new Error("Fixture has no measurable FM packet timeline");
  return { count: packets.length, bytes, digest: hash.digest("hex"), durationMs, packetHz: (packets.length - 1) / (durationMs / 1_000) };
}

async function launchScenario(mode: Mode, lapCount: number, sessionCount: number, fixture: string, seed: number, portOffset: number, profile: "active-user" | "archive-stress" = "active-user"): Promise<ScenarioResult & { diagnosticOutput: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), `raceiq-dashboard-contention-${mode}-`));
  const httpPort = 37_000 + (process.pid % 500) * 6 + portOffset;
  const udpPort = httpPort + 1;
  const child = spawn(process.execPath, ["run", CHILD, `--mode=${mode}`, `--lapCount=${lapCount}`, `--sessionCount=${sessionCount}`, `--seed=${seed}`, `--fixture=${fixture}`, `--httpPort=${httpPort}`, `--udpPort=${udpPort}`], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, RACEIQ_TEST_MODE: "0", NODE_ENV: "production", DASHBOARD_WORKLOAD_PROFILE: profile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  const append = (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString()}`.slice(-64_000); };
  child.stderr?.on("data", append);
  const lines = createInterface({ input: child.stdout! });
  const queued = new Map<string, ChildEvent[]>();
  const waiters = new Map<string, Array<(event: ChildEvent) => void>>();
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitPromise = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("error", exitPromise.reject);
  child.once("exit", (code, signal) => {
    exited = { code, signal };
    exitPromise.resolve(exited);
    for (const [event, listeners] of waiters) {
      for (const listener of listeners) listener({ event: "process-exit", code, signal, diagnostics });
      waiters.delete(event);
    }
  });
  lines.on("line", (line) => {
    append(Buffer.from(`${line}\n`));
    if (!line.startsWith("@dashboard-contention ")) return;
    let event: ChildEvent;
    try { event = JSON.parse(line.slice("@dashboard-contention ".length)) as ChildEvent; }
    catch { return; }
    const listeners = waiters.get(event.event);
    if (listeners?.length) listeners.shift()!(event);
    else {
      const list = queued.get(event.event) ?? [];
      list.push(event);
      queued.set(event.event, list);
    }
  });
  const receive = (event: string): Promise<ChildEvent> => {
    const list = queued.get(event);
    if (list?.length) return Promise.resolve(list.shift()!);
    if (exited) return Promise.reject(new Error(`Child exited before ${event}: ${diagnostics}`));
    const { promise, resolve: resolveEvent } = Promise.withResolvers<ChildEvent>();
    const listeners = waiters.get(event) ?? [];
    listeners.push(resolveEvent);
    waiters.set(event, listeners);
    return Promise.race([
      promise,
      exitPromise.promise.then(({ code, signal }) => { throw new Error(`Child exited (${code}, ${signal}) before ${event}: ${diagnostics}`); }),
    ]);
  };

  try {
    const ready = await receive("ready");
    child.stdin!.write("requests\n");
    await receive("requests-complete");
    child.stdin!.end("record\n");
    await receive("recording");
    const done = await receive("done") as unknown as ScenarioResult;
    const exit = await exitPromise.promise;
    if (exit.code !== 0 || exit.signal !== null) throw new Error(`Child failed (${exit.code}, ${exit.signal}): ${diagnostics}`);
    if (ready.mode !== mode || done.mode !== mode) throw new Error(`Child mode mismatch (${mode})`);
    return { ...done, diagnosticOutput: diagnostics };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exitPromise.promise.catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
  } finally {
    lines.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function verifyScenario(result: ScenarioResult, expectedWire: WireExpectation, enabled: boolean, output: string): Promise<void> {
  const cleanFinalization = result.mode === "finalization";
  const seedStateMatches = cleanFinalization
    ? result.fixture.metadataOnlyPublished === 0 && result.backfill.seededCaptureDirtyRows.beforeWorkload === 0
    : result.fixture.metadataOnlyPublished === result.fixture.sessionCount && result.backfill.seededCaptureDirtyRows.beforeWorkload === result.fixture.sessionCount;
  const finalizationMatches = cleanFinalization
    ? result.finalFields.status === "visible" && result.finalFields.recapFieldsMatched === true
    : enabled ? result.finalFields.status === "visible" || result.finalFields.status === "backlog-exception"
      : result.finalFields.status === "processor-disabled-baseline";
  const checks: Array<[boolean, string]> = [
    [result.sentDatagrams === expectedWire.count, "sender datagram count differs from fixture"],
    [result.recordedWire.count === expectedWire.count && result.recordedWire.bytes === expectedWire.bytes && result.recordedWire.digest === expectedWire.digest, "ordered UDP wire sequence in isolated raw recorder dump differs from committed fixture"],
    [Math.abs(expectedWire.packetHz - 60) <= 1, `source fixture rate is ${expectedWire.packetHz.toFixed(2)}Hz, not target 60Hz`],
    [result.replayTiming.actualPacketHz !== null && Math.abs(result.replayTiming.actualPacketHz - 60) <= 1, `actual UDP replay rate is ${result.replayTiming.actualPacketHz?.toFixed(2) ?? "unavailable"}Hz, not target 60Hz`],
    [Math.abs(result.replayTiming.actualDurationMs - expectedWire.durationMs) <= Math.max(1_000, expectedWire.durationMs * 0.02), "actual replay duration differs from fixture timestamp span"],
    [result.persistence.lapCount > 0 && result.persistence.duplicateLaps === 0, "recording produced no laps or duplicate lap inserts"],
    [result.persistence.writeCount > 0 && result.persistence.writeOverflow === 0 && result.persistence.writeP95Ms !== null, "lap persistence timing sample unavailable or overflowed"],
    [result.liveVisibility.persistedWrites > 0 && result.liveVisibility.visibleWrites === result.liveVisibility.persistedWrites && result.liveVisibility.maxDelayMs !== null && result.liveVisibility.maxDelayMs <= 2_000 && result.persistence.liveLapWriteOverflow === 0, "persisted live laps were not visible in actual dashboard GET within 2 seconds"],
    [result.metadataCompleteResponses.allTrue && result.metadataCompleteResponses.count >= result.requestOnly.count + result.concurrentRequests.count, "measured dashboard responses did not all assert metadataComplete=true"],
    [seedStateMatches, "seed state does not match scenario contract"],
    [result.requestOnly.byScope.every((scope) => scope.count >= 30) && result.concurrentRequests.byScope.every((scope) => scope.count >= 30), "fewer than 30 measured GETs for a request scope during either period"],
    [result.requestOnly.maxPayloadBytes <= 128 * 1024 && result.concurrentRequests.maxPayloadBytes <= 128 * 1024, "dashboard response exceeds 128 KiB"],
    [result.requestOnly.incrementalRssBytes <= 64 * MiB, "request RSS exceeds 64 MiB incremental budget"],
    [result.resources.workloadIncrementalRssBytes <= 128 * MiB, "recording/backfill RSS exceeds 128 MiB incremental budget"],
    [result.capture.maxConcurrentStreams <= 1 || !enabled, "more than one active source capture decoder"],
    [!enabled || result.backfill.drained === true, "backfill left dirty dashboard summaries"],
    [!cleanFinalization || (result.decodePublicationOrdering.observedDashboardPublicationCommits > 0 && result.decodePublicationOrdering.commitsWhileCaptureReadOpen === 0 && result.decodePublicationOrdering.maxCaptureStreamsAtPublication === 0), "clean finalization publication committed while benchmark observed capture decoding; scope is single child finalization path"],
    [finalizationMatches, "final-field visibility status does not accurately reflect processor/backlog state"],
  ];
  const lockErrors = /SQLITE_BUSY|database(?: table)? is locked|database is busy/i.test(result.diagnosticOutput ?? "");
  checks.push([!lockErrors, "SQLite lock error found in backend diagnostics"]);
  const failed = checks.filter(([passed]) => !passed).map(([, description]) => description);
  if (failed.length) {
    await writeFile(resolve(output), `${JSON.stringify({ status: "failed", failures: failed, expectedWire, scenario: result }, null, 2)}\n`);
    throw new Error(`${result.mode}: ${failed.join("; ")}. Evidence written to ${resolve(output)}`);
  }
}

async function main(): Promise<void> {
  const values = cliArgs(process.argv.slice(2));
  const output = values.output;
  if (!output) throw new Error("--output=<path> required");
  const profile = values.profile ?? "active-user";
  if (profile !== "active-user" && profile !== "archive-stress") throw new RangeError("--profile must be active-user or archive-stress");
  const laps = Number(values.laps ?? 12_480), sessions = Number(values.sessions ?? 1_248);
  const smallLaps = Number(values["small-laps"] ?? 120), smallSessions = Number(values["small-sessions"] ?? 12);
  const seed = Number(values.seed ?? 20261009);
  const fixture = values.fixture ?? DEFAULT_FIXTURE;
  if (![laps, sessions, smallLaps, smallSessions, seed].every(Number.isSafeInteger) || sessions <= 0 || smallSessions <= 0 || smallLaps <= 0 || laps <= 0) throw new Error("Lap/session/seed args must be positive safe integers");
  const fixturePath = resolve(ROOT, fixture);
  const expectedWire = sourceWireExpectation(fixturePath);
  const finalization = await launchScenario("finalization", 1, 1, fixture, seed, 6);
  await verifyScenario(finalization, expectedWire, true, output);
  if (finalization.finalFields.status !== "visible" || finalization.finalFields.recapFieldsMatched !== true) throw new Error("Clean-backlog finalization scenario did not publish matching recap fields");
  if (Math.abs(expectedWire.packetHz - 60) > 1 || finalization.replayTiming.actualPacketHz === null || Math.abs(finalization.replayTiming.actualPacketHz - 60) > 1) {
    throw new Error(`Fixture/live replay is not 60Hz: source=${expectedWire.packetHz.toFixed(2)}Hz, actual=${finalization.replayTiming.actualPacketHz?.toFixed(2) ?? "unavailable"}Hz`);
  }
  const scenarios = [
    await launchScenario("small", smallLaps, smallSessions, fixture, seed, 0),
    await launchScenario("baseline", laps, sessions, fixture, seed, 2, profile),
    await launchScenario("enabled", laps, sessions, fixture, seed, 4, profile),
  ];
  const [small, baseline, enabled] = scenarios;
  await verifyScenario(small, expectedWire, true, output);
  await verifyScenario(baseline, expectedWire, false, output);
  await verifyScenario(enabled, expectedWire, true, output);
  if (enabled.concurrentRequests.p95Ms === null || enabled.concurrentRequests.p95Ms > 500 || enabled.concurrentRequests.byScope.some((scope) => scope.p95Ms === null || scope.p95Ms > 500)) throw new Error(`Concurrent aggregate p95 or per-scope p95 exceeds 500ms: ${enabled.concurrentRequests.p95Ms}ms`);
  if (baseline.persistence.writeP95Ms === null || enabled.persistence.writeP95Ms === null || baseline.persistence.writeP95Ms <= 0 || enabled.persistence.writeP95Ms > 100) throw new Error("Lap persistence p95 exceeds 100ms or baseline unavailable");
  const writeRegression = (enabled.persistence.writeP95Ms - baseline.persistence.writeP95Ms) / baseline.persistence.writeP95Ms;
  if (writeRegression > 0.2) throw new Error(`Lap persistence regression ${(writeRegression * 100).toFixed(2)}% exceeds 20%`);
  if (baseline.persistence.lapIdentityDigest !== enabled.persistence.lapIdentityDigest || baseline.persistence.lapCount !== enabled.persistence.lapCount) throw new Error("Baseline and backfill-enabled recording persisted different lap identities/counts");
  const memoryDelta = enabled.resources.workloadIncrementalRssBytes - small.resources.workloadIncrementalRssBytes;
  const recordingBackfillRssDeltaBytes = Math.max(0, enabled.resources.workloadPeakRssBytes - baseline.resources.workloadPeakRssBytes);
  const rssPhaseCoverage = enabled.rssTrajectory.phases.every((phase) => Math.abs(phase.observedFraction - phase.targetFraction) <= 0.05);
  const memoryEvidence = {
    smallFixture: { laps: small.fixture.lapCount, sessions: small.fixture.sessionCount, idleRssBytes: small.resources.workloadIdleRssBytes, peakRssBytes: small.resources.workloadPeakRssBytes, incrementalRssBytes: small.resources.workloadIncrementalRssBytes, rssTrajectory: small.rssTrajectory },
    baseline: { laps: baseline.fixture.lapCount, sessions: baseline.fixture.sessionCount, idleRssBytes: baseline.resources.workloadIdleRssBytes, peakRssBytes: baseline.resources.workloadPeakRssBytes, incrementalRssBytes: baseline.resources.workloadIncrementalRssBytes, rssTrajectory: baseline.rssTrajectory },
    enabledFixture: { laps: enabled.fixture.lapCount, sessions: enabled.fixture.sessionCount, idleRssBytes: enabled.resources.workloadIdleRssBytes, peakRssBytes: enabled.resources.workloadPeakRssBytes, incrementalRssBytes: enabled.resources.workloadIncrementalRssBytes, rssTrajectory: enabled.rssTrajectory },
    growthFromSmallToLargeBytes: memoryDelta,
    backfillPeakDeltaBytes: recordingBackfillRssDeltaBytes,
    budgets: { existingProcessingRssBytes: 128 * MiB, existingRequestRssBytes: 64 * MiB },
  };
  const memoryFailures: string[] = [];
  if (memoryDelta > 128 * MiB) memoryFailures.push(`incremental RSS growth small-to-large ${memoryDelta} bytes exceeds existing 128 MiB processing budget`);
  if (enabled.rssTrajectory.midToTailGrowthBytes > 128 * MiB) memoryFailures.push(`enabled mid-to-tail RSS growth ${enabled.rssTrajectory.midToTailGrowthBytes} bytes exceeds existing 128 MiB processing budget`);
  if (recordingBackfillRssDeltaBytes > 128 * MiB) memoryFailures.push(`backfill peak RSS delta ${recordingBackfillRssDeltaBytes} bytes exceeds existing 128 MiB processing budget`);
  if (enabled.rssTrajectory.overflow || enabled.rssTrajectory.sampleCount < 5 || !rssPhaseCoverage) memoryFailures.push("enabled RSS phase samples overflowed or failed 25/50/75/95/100% replay coverage");
  if (memoryFailures.length) {
    const evidencePath = resolve(output);
    await writeFile(evidencePath, `${JSON.stringify({ status: "failed", failures: memoryFailures, memoryEvidence }, null, 2)}\n`);
    throw new Error(`${memoryFailures.join("; ")}. Evidence written to ${evidencePath}`);
  }
  const outputData = {
    acceptance: { laps, sessions, fixture, wire: expectedWire, aggregateP95Ms: enabled.concurrentRequests.p95Ms, concurrentScopeP95Ms: enabled.concurrentRequests.byScope, lapWriteBaselineP95Ms: baseline.persistence.writeP95Ms, lapWriteConcurrentP95Ms: enabled.persistence.writeP95Ms, lapWriteRegression: writeRegression, requestRssBytes: enabled.requestOnly.incrementalRssBytes, recordingBackfillRssBytes: enabled.resources.workloadIncrementalRssBytes, recordingBackfillRssDeltaBytes, memoryGrowthFrom100kTo1mBytes: memoryDelta, memoryEvidence, metadataCompleteResponses: enabled.metadataCompleteResponses, liveLapVisibility: enabled.liveVisibility, finalFields: enabled.finalFields, seededCaptureBackfill: enabled.backfill.seededCaptureDirtyRows, cleanBacklogFinalization: finalization.finalFields, actual60HzReplay: finalization.replayTiming },
    finalization, small, baseline, enabled,
    windowsGate: { status: "not-run", reason: "This run is local; repeat the same command on supported Windows target." },
  };
  await writeFile(resolve(output), `${JSON.stringify(outputData, null, 2)}\n`);
  console.log(JSON.stringify(outputData.acceptance, null, 2));
}

await main();
