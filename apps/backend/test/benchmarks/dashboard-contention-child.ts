import { createHash, type Hash } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";
import { initDb } from "@raceiq/backend-core/db/index";
import { RealDbAdapter, type DbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { lapDetector } from "@raceiq/backend-core/telemetry/live-pipeline";
import { startDashboardProcessor, type DashboardProcessorHandle } from "@raceiq/backend-core/session-capture/dashboard-processor";
import { DASHBOARD_PROCESSOR_VERSION, prepareDashboardPublicationCandidate, publishDashboardSession, setDashboardPublicationNotifier } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { setCaptureFileFactoryForTest } from "@raceiq/backend-core/session-capture/source-loader";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { notifyDriverProfileLap } from "../../src/driver-profile/runner";
import { initServerGameAdapters } from "../../src/games/init";
import { initMotecTargets } from "../../src/games/motec-init";
import app from "../../src/routes/index";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";
import { udpListener } from "../../src/runtime/udp-listener";
import { createDashboardFinalizationFixture, createDashboardFixture } from "./dashboard-read-model-fixture";
import type { DashboardRequest } from "@raceiq/shared/racing/sessions/dashboard";
import type { SessionRecap } from "@raceiq/shared/racing/sessions/types";
import { replayWithClock } from "./recorder-bench-replay";

const ROOT = resolve(import.meta.dir, "../../../../");
const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const [key, ...value] = entry.replace(/^--/, "").split("=");
  return [key!, value.join("=")];
}));
const mode = args.mode;
const gameId = "fm-2023" as const;

function liveVisibilityRequest(): DashboardRequest {
  const to = Date.now();
  return { from: new Date(to - 365 * 86_400_000).toISOString(), to: new Date(to).toISOString(), timeZone: "UTC", gameId };
}
const fixture = args.fixture ?? "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const dataDir = process.env.DATA_DIR;
const httpPort = Number(args.httpPort);
const udpPort = Number(args.udpPort);
if (!dataDir || !Number.isInteger(httpPort) || !Number.isInteger(udpPort) || !["baseline", "enabled", "small", "finalization"].includes(mode ?? "")) {
  throw new Error("DATA_DIR and valid mode/httpPort/udpPort required");
}

function percentile(values: number[], p: number): number | null {
  return values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? null : null;
}

let metadataCompleteResponses = 0;
async function dashboardRequest(scope: DashboardRequest): Promise<{ elapsedMs: number; payloadBytes: number; totalLaps: number; latestRecapSessionId: number | null; recentSessionIds: number[] }> {
  const query = new URLSearchParams({ from: scope.from, to: scope.to, timeZone: scope.timeZone });
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${httpPort}/api/dashboard?${query}`, {
    headers: scope.gameId ? { "X-Game-Id": scope.gameId } : undefined,
  });
  const bytes = await response.arrayBuffer();
  if (!response.ok) throw new Error(`Dashboard GET failed ${response.status}: ${new TextDecoder().decode(bytes)}`);
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
    coverage?: { metadataComplete?: unknown };
    totals?: { laps?: unknown };
    latestRecapSessionId?: unknown;
    recentSessions?: Array<{ id?: unknown }>;
  };
  if (payload.coverage?.metadataComplete !== true) throw new Error("Measured dashboard GET returned metadataComplete=false");
  metadataCompleteResponses++;
  if (typeof payload.totals?.laps !== "number" || !Number.isFinite(payload.totals.laps)) throw new Error("Measured dashboard GET lacks exact lap total");
  return {
    elapsedMs: performance.now() - started, payloadBytes: bytes.byteLength, totalLaps: payload.totals.laps,
    latestRecapSessionId: typeof payload.latestRecapSessionId === "number" ? payload.latestRecapSessionId : null,
    recentSessionIds: (payload.recentSessions ?? []).flatMap((session) => typeof session.id === "number" ? [session.id] : []),
  };
}
async function dashboardRecap(sessionId: number): Promise<SessionRecap | null> {
  const response = await fetch(`http://127.0.0.1:${httpPort}/api/dashboard/sessions/${sessionId}/recap`, { headers: { "X-Game-Id": gameId } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Dashboard recap GET failed ${response.status}: ${await response.text()}`);
  return await response.json() as SessionRecap;
}

async function nextCommand(): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  process.stdin.once("data", (chunk) => resolve(chunk.toString().trim()));
  return promise;
}

async function measuredRequestBatch(scopes: DashboardRequest[], count: number): Promise<{ latenciesMs: number[]; payloadBytes: number[]; idleRssBytes: number; peakRssBytes: number; baselineTotalLaps: number | null; byScope: Array<{ scopeKey: string; count: number; p95Ms: number | null }> }> {
  if (!scopes.length) throw new Error("Fixture returned no dashboard request scopes");
  const idleRssBytes = process.memoryUsage().rss;
  let peakRssBytes = idleRssBytes, baselineTotalLaps: number | null = null;
  const timer = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 25);
  const latenciesMs: number[] = [], payloadBytes: number[] = [];
  const scopeLatencies = scopes.map((): number[] => []);
  try {
    for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
      for (let index = 0; index < 5 + count; index++) {
        const sample = await dashboardRequest(scopes[scopeIndex]!);
        if (index >= 5) {
          latenciesMs.push(sample.elapsedMs);
          payloadBytes.push(sample.payloadBytes);
          scopeLatencies[scopeIndex]!.push(sample.elapsedMs);
          if (scopeIndex === 0 && baselineTotalLaps === null) baselineTotalLaps = sample.totalLaps;
        }
      }
    }
  } finally {
    clearInterval(timer);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  const byScope = scopes.map((scope, index) => {
    const sorted = [...scopeLatencies[index]!].sort((left, right) => left - right);
    return { scopeKey: `${scope.gameId ?? "all"}|${scope.from}|${scope.timeZone}`, count: sorted.length, p95Ms: percentile(sorted, 0.95) };
  });
  return { latenciesMs, payloadBytes, idleRssBytes, peakRssBytes, baselineTotalLaps, byScope };
}

const writeLatencies: number[] = [];
const liveLapPersistedAtMs: number[] = [];
let writeLatencyOverflow = 0;
let liveLapWriteOverflow = 0;
let measureWrites = false;
const originalInsertLap: DbAdapter["insertLap"] = RealDbAdapter.prototype.insertLap;
RealDbAdapter.prototype.insertLap = async function (this: RealDbAdapter, ...params: Parameters<DbAdapter["insertLap"]>) {
  if (!measureWrites) return originalInsertLap.apply(this, params);
  const started = performance.now();
  try {
    const result = await originalInsertLap.apply(this, params);
    if (liveLapPersistedAtMs.length < 10_000) liveLapPersistedAtMs.push(Date.now());
    else liveLapWriteOverflow++;
    return result;
  } finally {
    if (writeLatencies.length < 10_000) writeLatencies.push(performance.now() - started);
    else writeLatencyOverflow++;
  }
};

const lengthPrefix = Buffer.allocUnsafe(4);
const framedHash = (hash: Hash, frame: Buffer) => {
  lengthPrefix.writeUInt32LE(frame.length);
  hash.update(lengthPrefix);
  hash.update(frame);
};

let processor: DashboardProcessorHandle | null = null;
let server: { stop(force?: boolean): void } | null = null;
let beforeSessionId = 0;
const liveCaptureStreams = { active: 0, maximum: 0 };
let publicationCommits = 0, publicationCommitsDuringCaptureRead = 0, maxCaptureStreamsAtPublication = 0;
const sqlitePath = `${dataDir}/app.db`;
const fixtureOptions = {
  lapCount: Number(args.lapCount),
  sessionCount: Number(args.sessionCount),
  seed: Number(args.seed),
  distribution: "standard" as const,
  publish: mode === "finalization",
};
if (!Number.isSafeInteger(fixtureOptions.lapCount) || !Number.isSafeInteger(fixtureOptions.sessionCount) || !Number.isSafeInteger(fixtureOptions.seed)) {
  throw new Error("lapCount/sessionCount/seed must be safe integers");
}

await initDb();
initGameAdapters(serverReleaseFeatures);
initServerGameAdapters();
initMotecTargets();
registerDriverProfileLapNotifier(notifyDriverProfileLap);
const fixtureResult = mode === "finalization"
  ? await createDashboardFinalizationFixture()
  : await createDashboardFixture(fixtureOptions);
using db = new Database(sqlitePath, { readonly: true });
beforeSessionId = Number(db.query<{ id: number }, []>("SELECT COALESCE(MAX(id),0) AS id FROM sessions").get()?.id ?? 0);
let metadataOnlyPublished = 0, lastMetadataSessionId = 0;
if (mode !== "finalization") {
  for (;;) {
    const pending = db.query<{ session_id: number }, [number]>(
      "SELECT session_id FROM dashboard_summary_state WHERE session_id>? AND metadata_dirty=1 ORDER BY session_id LIMIT 100",
    ).all(lastMetadataSessionId);
    if (!pending.length) break;
    for (const row of pending) {
      lastMetadataSessionId = row.session_id;
      const candidate = await prepareDashboardPublicationCandidate(row.session_id);
      if (!candidate || !await publishDashboardSession(candidate, undefined, { metadataOnly: true })) {
        throw new Error(`Failed bounded metadata-only publication for seeded session ${row.session_id}`);
      }
      metadataOnlyPublished++;
    }
  }
  if (metadataOnlyPublished !== fixtureOptions.sessionCount) {
    throw new Error(`Metadata-only seed publication covered ${metadataOnlyPublished}/${fixtureOptions.sessionCount} sessions`);
  }
}
const seedCaptureDirtyRowsBeforeWorkload = Number(db.query<{ count: number }, [number]>(
  "SELECT COUNT(*) AS count FROM dashboard_summary_state WHERE session_id<=? AND capture_dirty=1",
).get(beforeSessionId)?.count ?? 0);
setDashboardPublicationNotifier(() => {
  publicationCommits++;
  maxCaptureStreamsAtPublication = Math.max(maxCaptureStreamsAtPublication, liveCaptureStreams.active);
  if (liveCaptureStreams.active > 0) publicationCommitsDuringCaptureRead++;
});
setCaptureFileFactoryForTest((path) => {
  const file = Bun.file(path);
  return {
    size: file.size,
    lastModified: file.lastModified,
    slice: (start?: number, end?: number, contentType?: string) => file.slice(start, end, contentType),
    stream: () => {
      const reader = file.stream().getReader();
      liveCaptureStreams.active++;
      liveCaptureStreams.maximum = Math.max(liveCaptureStreams.maximum, liveCaptureStreams.active);
      let finished = false;
      const finish = () => { if (!finished) { finished = true; liveCaptureStreams.active--; } };
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { finish(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) { finish(); controller.error(error); }
        },
        async cancel(reason) { finish(); await reader.cancel(reason); },
      });
    },
    arrayBuffer: () => file.arrayBuffer(),
  };
});

process.chdir(dataDir);
udpListener.setRecordingGameId(gameId);
server = Bun.serve({ port: httpPort, hostname: "127.0.0.1", fetch: app.fetch });
await udpListener.start(udpPort, "127.0.0.1");
const fixtureRequests = fixtureResult.requestScopes;
const fixtureMetadata = { options: fixtureResult.options, expected: fixtureResult.expected };
console.log(`@dashboard-contention ${JSON.stringify({ event: "ready", mode, fixture: fixtureMetadata, requestScopes: fixtureRequests, latestRecapSessionId: fixtureResult.latestRecapSessionId })}`);

if (await nextCommand() !== "requests") throw new Error("Expected requests command");
const requestOnly = await measuredRequestBatch(fixtureRequests as DashboardRequest[], 30);
const liveVisibilityBaseline = await dashboardRequest(liveVisibilityRequest());
let liveLapVisibleCount = 0;
const liveLapVisibilityDelaysMs: number[] = [];
const observeLiveLapVisibility = (sample: Awaited<ReturnType<typeof dashboardRequest>>) => {
  const visibleDelta = Math.max(0, Math.floor(sample.totalLaps - liveVisibilityBaseline.totalLaps));
  const visibleTarget = Math.min(visibleDelta, liveLapPersistedAtMs.length);
  while (liveLapVisibleCount < visibleTarget) {
    const persistedAt = liveLapPersistedAtMs[liveLapVisibleCount]!;
    const delayMs = Date.now() - persistedAt;
    liveLapVisibilityDelaysMs.push(delayMs);
    if (delayMs > 2_000) throw new Error(`Actual persisted live lap ${liveLapVisibleCount + 1} became visible after ${delayMs}ms`);
    liveLapVisibleCount++;
  }
};
console.log(`@dashboard-contention ${JSON.stringify({
  event: "requests-complete", requests: { count: requestOnly.latenciesMs.length, p50Ms: percentile([...requestOnly.latenciesMs].sort((a, b) => a - b), 0.5), p95Ms: percentile([...requestOnly.latenciesMs].sort((a, b) => a - b), 0.95), maxPayloadBytes: Math.max(...requestOnly.payloadBytes), idleRssBytes: requestOnly.idleRssBytes, peakRssBytes: requestOnly.peakRssBytes,
  incrementalRssBytes: Math.max(0, requestOnly.peakRssBytes - requestOnly.idleRssBytes) },
})}`);
if (await nextCommand() !== "record") throw new Error("Expected record command");
if (mode !== "baseline") processor = startDashboardProcessor();
measureWrites = true;
let workloadPeakRssBytes = process.memoryUsage().rss;
const workloadIdleRssBytes = workloadPeakRssBytes;
const workloadRssSamples: Array<{ elapsedMs: number; rssBytes: number; replaySentCount: number }> = [];
const workloadStartedAt = performance.now();
let replaySentProgress = 0, rssSamplingOverflow = false;
const sampleWorkloadRss = () => {
  const now = performance.now(), rssBytes = process.memoryUsage().rss;
  workloadPeakRssBytes = Math.max(workloadPeakRssBytes, rssBytes);
  if (workloadRssSamples.length < 10_000) workloadRssSamples.push({ elapsedMs: now - workloadStartedAt, rssBytes, replaySentCount: replaySentProgress });
  else rssSamplingOverflow = true;
};
sampleWorkloadRss();
const workloadSampleTimer = setInterval(sampleWorkloadRss, 1_000);
const workloadTimer = setInterval(() => { workloadPeakRssBytes = Math.max(workloadPeakRssBytes, process.memoryUsage().rss); }, 25);
console.log(`@dashboard-contention ${JSON.stringify({ event: "recording" })}`);
const concurrentLatencies: number[] = [], concurrentPayloadBytes: number[] = [];
const concurrentScopeLatencies = fixtureRequests.map((): number[] => []);
let replayFinished = false, firstSentAtNs: bigint | null = null, lastSentAtNs: bigint | null = null;
const replayPromise = replayWithClock(resolve(ROOT, fixture), gameId, udpPort, 1, undefined, (sentAtNs) => {
  replaySentProgress++;
  firstSentAtNs ??= sentAtNs;
  lastSentAtNs = sentAtNs;
}).then((count) => {
  replayFinished = true;
  console.log(`@dashboard-contention ${JSON.stringify({ event: "replay-finished", sentDatagrams: count })}`);
  return count;
});
while (!replayFinished) {
  const scopeIndex = concurrentLatencies.length % fixtureRequests.length;
  const sample = await dashboardRequest(fixtureRequests[scopeIndex]!);
  if (scopeIndex === 0) observeLiveLapVisibility(await dashboardRequest(liveVisibilityRequest()));
  if (concurrentLatencies.length < 20_000) {
    concurrentLatencies.push(sample.elapsedMs);
    concurrentPayloadBytes.push(sample.payloadBytes);
    concurrentScopeLatencies[scopeIndex]!.push(sample.elapsedMs);
  } else throw new Error("Concurrent request sample bound exceeded");
  await Bun.sleep(100);
}
const sentDatagrams = await replayPromise;
const actualReplayDurationMs = firstSentAtNs !== null && lastSentAtNs !== null ? Number(lastSentAtNs - firstSentAtNs) / 1_000_000 : 0;
const replayTiming = { actualDurationMs: actualReplayDurationMs, actualPacketHz: sentDatagrams > 1 && actualReplayDurationMs > 0 ? (sentDatagrams - 1) / (actualReplayDurationMs / 1_000) : null };
const seedCaptureDirtyRowsAtReplayEnd = Number(db.query<{ count: number }, [number]>(
  "SELECT COUNT(*) AS count FROM dashboard_summary_state WHERE session_id<=? AND capture_dirty=1",
).get(beforeSessionId)?.count ?? 0);
await Bun.sleep(500);
await udpListener.stop();
const recordingDir = resolve(dataDir, "test", "artifacts", "sessions");
const recordingFiles = await readdir(recordingDir);
if (recordingFiles.length !== 1) throw new Error(`Expected one isolated UDP dump, found ${recordingFiles.length}`);
const recordedPackets = readUdpDump(resolve(recordingDir, recordingFiles[0]!));
const recordedHash = createHash("sha256");
let recordedBytes = 0;
for (const packet of recordedPackets) {
  recordedBytes += packet.length;
  framedHash(recordedHash, packet);
}
const recordedWire = { count: recordedPackets.length, bytes: recordedBytes, digest: recordedHash.digest("hex") };
const finalizationStartedAt = performance.now();
await lapDetector.finalizeCurrentSession();
const seedCaptureDirtyRowsAfterRecording = Number(db.query<{ count: number }, [number]>(
  "SELECT COUNT(*) AS count FROM dashboard_summary_state WHERE session_id<=? AND capture_dirty=1",
).get(beforeSessionId)?.count ?? 0);
if (liveLapWriteOverflow > 0) throw new Error(`Live-lap visibility tracker overflowed by ${liveLapWriteOverflow} writes`);
while (liveLapVisibleCount < liveLapPersistedAtMs.length) {
  const firstPendingAt = liveLapPersistedAtMs[liveLapVisibleCount]!;
  if (Date.now() - firstPendingAt > 2_000) throw new Error(`Persisted live laps visible ${liveLapVisibleCount}/${liveLapPersistedAtMs.length} after 2 seconds`);
  observeLiveLapVisibility(await dashboardRequest(liveVisibilityRequest()));
  if (liveLapVisibleCount < liveLapPersistedAtMs.length) await Bun.sleep(100);
}
const liveSessionId = db.query<{ id: number }, [number, string]>(
  "SELECT id FROM sessions WHERE id>? AND game_id=? AND ownership='mine' ORDER BY id DESC LIMIT 1",
).get(beforeSessionId, gameId)?.id ?? null;
let finalFields: { status: string; sessionId: number | null; elapsedMs?: number; reason?: string; revision?: number; durationStatus?: string; durationElapsedSeconds?: number | null; weatherStatus?: string; sectorStatus?: string; recapFieldsMatched?: boolean };
if (mode === "baseline") {
  finalFields = { status: "processor-disabled-baseline", sessionId: liveSessionId, reason: "Baseline intentionally runs without the background dashboard processor." };
} else if (seedCaptureDirtyRowsAfterRecording > 0) {
  if (mode === "finalization") throw new Error(`Clean-backlog finalization fixture unexpectedly retained ${seedCaptureDirtyRowsAfterRecording} seeded capture-dirty rows`);
  finalFields = { status: "backlog-exception", sessionId: liveSessionId, reason: `${seedCaptureDirtyRowsAfterRecording} seeded capture-dirty sessions remain after recording; final-field latency excluded.` };
} else {
  if (liveSessionId === null) throw new Error("Recording produced no live session for final-field verification");
  const deadline = finalizationStartedAt + 5_000;
  const evidenceQuery = db.query<{
    source_revision: number; published_revision: number; metadata_dirty: number; capture_dirty: number; deleted: number;
    processor_version: number; summary_revision: number; summary_processor_version: number; evidence_version: number;
    capture_revision: string | null; valid_seconds: number | null; valid_laps: number; distance_meters: number | null;
    duration_status: string; elapsed_seconds: number | null; weather_status: string; weather_conditions_json: string | null;
    sector_status: string; source_sector_starts_json: string | null;
  }, [number]>(`SELECT st.source_revision,st.published_revision,st.metadata_dirty,st.capture_dirty,st.deleted,st.processor_version,
      d.source_revision AS summary_revision,d.processor_version AS summary_processor_version,d.evidence_version,d.capture_revision,
      d.valid_seconds,d.valid_laps,d.distance_meters,d.duration_status,d.elapsed_seconds,d.weather_status,d.weather_conditions_json,
      d.sector_status,d.source_sector_starts_json
    FROM dashboard_summary_state st JOIN dashboard_session_summaries d ON d.session_id=st.session_id WHERE st.session_id=?`);
  const near = (actual: number | null | undefined, expected: number | null): boolean =>
    actual == null || expected == null ? actual == null && expected == null : Math.abs(actual - expected) <= 1e-6;
  let visibleEvidence: ReturnType<typeof evidenceQuery.get> | null = null;
  let visibleRevision: number | null = null;
  while (performance.now() < deadline) {
    const before = evidenceQuery.get(liveSessionId);
    if (before && before.metadata_dirty === 0 && before.capture_dirty === 0 && before.deleted === 0
      && before.source_revision === before.published_revision && before.summary_revision === before.source_revision
      && before.processor_version === DASHBOARD_PROCESSOR_VERSION && before.summary_processor_version === DASHBOARD_PROCESSOR_VERSION
      && before.evidence_version === DASHBOARD_PROCESSOR_VERSION && before.capture_revision) {
      const recap = await dashboardRecap(liveSessionId);
      const after = evidenceQuery.get(liveSessionId);
      if (recap && after && after.source_revision === before.source_revision && after.published_revision === before.published_revision
        && after.metadata_dirty === 0 && after.capture_dirty === 0 && after.summary_revision === after.source_revision) {
        const expectedWeather = before.weather_status === "available" && before.weather_conditions_json
          ? JSON.parse(before.weather_conditions_json) as { rainIntensity?: number }
          : null;
        const expectedSectorStarts = before.sector_status === "available" && before.source_sector_starts_json
          ? JSON.parse(before.source_sector_starts_json) as number[]
          : null;
        const weatherMatches = expectedWeather
          ? recap.weather != null && near(recap.weather.rainPercent, typeof expectedWeather.rainIntensity === "number" ? expectedWeather.rainIntensity * 100 : null)
          : recap.weather == null;
        const sectorsMatch = expectedSectorStarts
          ? JSON.stringify(recap.sectorStarts) === JSON.stringify(expectedSectorStarts)
          : recap.sectorStarts == null;
        const lapDurationMatches = near(recap.timeOnTrackSec, before.valid_seconds);
        const validLapsMatch = recap.lapsValid === before.valid_laps;
        const distanceMatches = near(recap.distanceM, before.distance_meters);
        if (weatherMatches && sectorsMatch && lapDurationMatches && validLapsMatch && distanceMatches) {
          visibleEvidence = before;
          visibleRevision = before.source_revision;
          break;
        }
      }
    }
    await Bun.sleep(100);
  }
  if (!visibleEvidence || visibleRevision === null) {
    throw new Error(`Live session ${liveSessionId} current-revision recap fields did not match processor facts within 5s of finalization`);
  }
  finalFields = {
    status: "visible", sessionId: liveSessionId, elapsedMs: performance.now() - finalizationStartedAt,
    revision: visibleRevision, durationStatus: visibleEvidence.duration_status,
    durationElapsedSeconds: visibleEvidence.elapsed_seconds, weatherStatus: visibleEvidence.weather_status,
    sectorStatus: visibleEvidence.sector_status, recapFieldsMatched: true,
  };
}
measureWrites = false;


let dirtyRows = 0;
if (processor) {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    dirtyRows = Number(db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM dashboard_summary_state
      WHERE metadata_dirty=1 OR capture_dirty=1 OR published_revision!=source_revision`).get()?.count ?? 0);
    if (dirtyRows === 0) break;
    await Bun.sleep(250);
  }
  await processor.stop();
}
const seedCaptureDirtyRowsAfterDrain = Number(db.query<{ count: number }, [number]>(
  "SELECT COUNT(*) AS count FROM dashboard_summary_state WHERE session_id<=? AND capture_dirty=1",
).get(beforeSessionId)?.count ?? 0);
clearInterval(workloadTimer);
clearInterval(workloadSampleTimer);
sampleWorkloadRss();
setDashboardPublicationNotifier(null);
workloadPeakRssBytes = Math.max(workloadPeakRssBytes, process.memoryUsage().rss);
const concurrentSorted = [...concurrentLatencies].sort((left, right) => left - right);
const concurrentByScope = fixtureRequests.map((scope, index) => {
  const sorted = [...concurrentScopeLatencies[index]!].sort((left, right) => left - right);
  return { scopeKey: `${scope.gameId ?? "all"}|${scope.from}|${scope.timeZone}`, count: sorted.length, p95Ms: percentile(sorted, 0.95) };
});
const concurrentRequests = { count: concurrentLatencies.length, p50Ms: percentile(concurrentSorted, 0.5), p95Ms: percentile(concurrentSorted, 0.95), maxPayloadBytes: Math.max(...concurrentPayloadBytes), idleRssBytes: workloadIdleRssBytes, peakRssBytes: workloadPeakRssBytes, incrementalRssBytes: Math.max(0, workloadPeakRssBytes - workloadIdleRssBytes), byScope: concurrentByScope };
const rssPhases = [0.25, 0.5, 0.75, 0.95, 1].map((targetFraction) => {
  const sample = workloadRssSamples.reduce((best, current) =>
    Math.abs(current.replaySentCount / sentDatagrams - targetFraction) < Math.abs(best.replaySentCount / sentDatagrams - targetFraction) ? current : best);
  return { targetFraction, observedFraction: sentDatagrams === 0 ? 0 : sample.replaySentCount / sentDatagrams, elapsedMs: sample.elapsedMs, rssBytes: sample.rssBytes };
});
const rssMidpointBytes = rssPhases[1]!.rssBytes;
const rssTailPeakBytes = Math.max(rssPhases[2]!.rssBytes, rssPhases[3]!.rssBytes, rssPhases[4]!.rssBytes);
const rssTrajectory = {
  sampleCount: workloadRssSamples.length, samplingIntervalMs: 1_000, overflow: rssSamplingOverflow,
  phases: rssPhases, midToTailGrowthBytes: Math.max(0, rssTailPeakBytes - rssMidpointBytes),
};
const liveRows = db.query<{ id: number; game_id: string; raw_file: string | null; source: string | null; car_ordinal: number; track_ordinal: number }, [number, string]>(
  "SELECT id,game_id,raw_file,source,car_ordinal,track_ordinal FROM sessions WHERE id>? AND game_id=? AND ownership='mine' ORDER BY id",
).all(beforeSessionId, gameId);
const liveSessionIds = liveRows.map((row) => row.id);

const lapCount = Number(db.query<{ count: number }, [number, string]>("SELECT COUNT(*) AS count FROM laps WHERE session_id>? AND session_id IN (SELECT id FROM sessions WHERE game_id=? AND ownership='mine')").get(beforeSessionId, gameId)?.count ?? 0);
const duplicateLaps = Number(db.query<{ count: number }, [number, string]>(`SELECT COUNT(*) AS count FROM (
  SELECT l.session_id,l.lap_number FROM laps l JOIN sessions s ON s.id=l.session_id
  WHERE l.session_id>? AND s.game_id=? AND s.ownership='mine' GROUP BY l.session_id,l.lap_number HAVING COUNT(*)>1
`).get(beforeSessionId, gameId)?.count ?? 0);
const lapHash = createHash("sha256");
for (const lap of db.query<{ session_id: number; lap_number: number; lap_time: number; is_valid: number }, [number, string]>(
  "SELECT l.session_id,l.lap_number,l.lap_time,l.is_valid FROM laps l JOIN sessions s ON s.id=l.session_id WHERE l.session_id>? AND s.game_id=? AND s.ownership='mine' ORDER BY l.session_id,l.lap_number",
).iterate(beforeSessionId, gameId)) lapHash.update(`${lap.session_id}:${lap.lap_number}:${lap.lap_time}:${lap.is_valid}\n`);

setCaptureFileFactoryForTest(null);
server.stop(true);
server = null;

const sortedWrites = [...writeLatencies].sort((left, right) => left - right);
const result = {
  decodePublicationOrdering: {
    observedDashboardPublicationCommits: publicationCommits,
    commitsWhileCaptureReadOpen: publicationCommitsDuringCaptureRead,
    maxCaptureStreamsAtPublication,
    scope: "this child; publication notifier is post-commit; capture stream activity only; not a process-wide transaction-overlap claim",
    structuralOrder: "processDashboardSession awaits readCaptureFacts and revision recheck before calling publishDashboardSession; publisher begins its write transaction afterward",
  },
  rssTrajectory,
  event: "done", mode, sentDatagrams, requestOnly: {
    count: requestOnly.latenciesMs.length, p50Ms: percentile([...requestOnly.latenciesMs].sort((left, right) => left - right), 0.5),
    p95Ms: percentile([...requestOnly.latenciesMs].sort((left, right) => left - right), 0.95), maxPayloadBytes: Math.max(...requestOnly.payloadBytes),
    idleRssBytes: requestOnly.idleRssBytes, peakRssBytes: requestOnly.peakRssBytes,
    incrementalRssBytes: Math.max(0, requestOnly.peakRssBytes - requestOnly.idleRssBytes),
    baselineTotalLaps: requestOnly.baselineTotalLaps, byScope: requestOnly.byScope,
  },
  concurrentRequests,
  replayTiming,
  liveVisibility: { persistedWrites: liveLapPersistedAtMs.length, visibleWrites: liveLapVisibleCount, maxDelayMs: liveLapVisibilityDelaysMs.length ? Math.max(...liveLapVisibilityDelaysMs) : null, delaysMs: liveLapVisibilityDelaysMs },
  finalFields,
  metadataCompleteResponses: { count: metadataCompleteResponses, allTrue: true },
  recordedWire,
  capture: { sessionCount: liveRows.length, sessionIds: liveSessionIds, maxConcurrentStreams: liveCaptureStreams.maximum },
  persistence: { lapCount, duplicateLaps, lapIdentityDigest: lapHash.digest("hex"), writeCount: writeLatencies.length, writeOverflow: writeLatencyOverflow, liveLapWriteOverflow, writeP95Ms: percentile(sortedWrites, 0.95) },
  backfill: {
    dirtyRows, drained: mode === "baseline" ? null : dirtyRows === 0,
    seededCaptureDirtyRows: { beforeWorkload: seedCaptureDirtyRowsBeforeWorkload, atReplayEnd: seedCaptureDirtyRowsAtReplayEnd, clearedDuringReplay: Math.max(0, seedCaptureDirtyRowsBeforeWorkload - seedCaptureDirtyRowsAtReplayEnd), afterRecording: seedCaptureDirtyRowsAfterRecording, afterDrain: seedCaptureDirtyRowsAfterDrain },
  },
  resources: { workloadIdleRssBytes, workloadPeakRssBytes, workloadIncrementalRssBytes: Math.max(0, workloadPeakRssBytes - workloadIdleRssBytes), samplingIntervalMs: 25, scope: "single backend child process; no benchmark descendants" },
  fixture: { lapCount: fixtureOptions.lapCount, sessionCount: fixtureOptions.sessionCount, metadataOnlyPublished, metadata: fixtureMetadata },
};
console.log(`@dashboard-contention ${JSON.stringify(result)}`);
