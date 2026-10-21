import { afterAll, describe, expect, test } from "bun:test";
import { F1StateAccumulator } from "@raceiq/game-f1-2025/f1-state";
import { F1_HEADER_SIZE, F1_PACKET_IDS, type F1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { CapturingDbAdapter, NullSessionRecorderAdapter, NullWsAdapter, RealDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { captureLapDriverAttribution, encodeNativeDriverBinding, nativeDriverBindings, NativeAttributionTracker, NativeBindingCandidateCache, getNativeSourceClock, validateNativeDriverBinding } from "@raceiq/backend-core/lap-detection/native-attribution";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { classifyLapAttribution, type NativeDriverActor } from "@raceiq/shared/driver-attribution";
import { client } from "@raceiq/backend-core/db/index";
import { claimLocalAccountOwner, getLocalAccountOwner, getLocalGameBindingSnapshot, upsertLocalGameBinding } from "@raceiq/backend-core/db/local-account-queries";
import { readOriginalActivitySourceProof } from "@raceiq/backend-core/db/original-activity-queries";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { listSessionDriverAttributionStints } from "@raceiq/backend-core/db/driver-summary-ledger-queries";
import { installDatabaseWriteTestHooks, withDatabaseTransaction, withDatabaseWrite } from "@raceiq/backend-core/db/write-coordination";

initGameAdapters();
initServerGameAdapters();
afterAll(stopMaintenanceTasks);

function sourceActor(sessionId = "1", networkId = 7, observedAtMs = 100_000.25): NativeDriverActor {
  return { gameId: "f1-2025", source: "f1-2025-udp-participant", actorId: `${sessionId}:network:${networkId}`,
    bindingScope: "session", sessionId, clockDomain: `f1-2025-session:${sessionId}`, observedAtMs };
}
function binding(actor = sourceActor()) {
  return { id: "local-native", gameId: actor.gameId, sourceKind: actor.source,
    nativeIdentity: encodeNativeDriverBinding(actor), confirmation: "user_confirmed" as const, revision: 1 };
}

/** Actual native F1 parser produces normalized packets; names intentionally collide. */
function nativePackets(sessionId = "1") {
  const parser = new F1StateAccumulator();
  let sequence = 0;
  const feed = (packetId: number, data: Buffer, atSeconds: number) => {
    const header: F1Header = { packetFormat: 2025, gameYear: 25, gameMajorVersion: 1, gameMinorVersion: 0,
      packetVersion: 1, packetId, sessionUID: BigInt(sessionId), sessionTime: atSeconds,
      frameIdentifier: sequence, overallFrameIdentifier: sequence++, playerCarIndex: 0, secondaryPlayerCarIndex: 255 };
    return parser.feed(header, Buffer.concat([Buffer.alloc(F1_HEADER_SIZE), data]));
  };
  return (atSeconds: number, lapSeconds: number, lapNumber: number, networkId: number | null = 7,
    control?: { skipSession?: boolean; paused?: boolean; spectating?: boolean }): TelemetryPacket => {
    const participants = Buffer.alloc(58);
    participants[0] = 1;
    participants[1] = 0;
    participants[3] = networkId ?? 7;
    participants.write("Same Name", 8, "utf8");
    if (networkId !== null) feed(F1_PACKET_IDS.PARTICIPANTS, participants, atSeconds);
    const lap = Buffer.alloc(57);
    lap.writeUInt32LE(lapNumber > 1 ? 20_000 : 0, 0);
    lap.writeUInt32LE(Math.round(lapSeconds * 1000), 4);
    lap.writeFloatLE(lapSeconds * 50, 20);
    lap.writeFloatLE((atSeconds - 100.00025) * 50, 24);
    lap[32] = 1;
    lap[33] = lapNumber;
    feed(F1_PACKET_IDS.LAP_DATA, lap, atSeconds);
    if (!control?.skipSession) {
      const session = Buffer.alloc(16);
      session[14] = control?.paused ? 1 : 0;
      session[15] = control?.spectating ? 1 : 0;
      feed(F1_PACKET_IDS.SESSION, session, atSeconds);
    }
    const motion = Buffer.alloc(60);
    motion.writeFloatLE(lapSeconds * 50, 8);
    feed(F1_PACKET_IDS.MOTION, motion, atSeconds);
    const status = Buffer.alloc(55);
    status.writeFloatLE(50 - lapSeconds * 0.02, 5);
    feed(F1_PACKET_IDS.CAR_STATUS, status, atSeconds);
    const telemetry = Buffer.alloc(60);
    telemetry.writeUInt16LE(180, 0);
    const packet = feed(F1_PACKET_IDS.CAR_TELEMETRY, telemetry, atSeconds);
    if (!packet) throw new Error("Native F1 fixture did not produce telemetry");
    return packet;
  };
}
async function capture(options: { db?: CapturingDbAdapter; onMidpoint?: () => Promise<void>; sessionId?: string; swap?: boolean; other?: boolean; stale?: boolean; gap?: boolean; suppressed?: boolean; partial?: boolean; incomplete?: boolean; bindLater?: boolean; rebindWithSwap?: boolean; participantCadence?: number; paused?: boolean; spectating?: boolean; staleSessionTail?: boolean } = {}) {
  const db = options.db ?? new CapturingDbAdapter();
  db.driverBindings = options.bindLater ? { revision: 0, bindings: [] } : { revision: 1, bindings: [binding()] };
  const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), { bypassPacketRateFilter: true,
    skipHistorySeeding: true, skipDevState: true, enqueueSessionCaptureSplits: false, recorder: new NullSessionRecorderAdapter() });
  const next = nativePackets(options.sessionId);
  for (let index = options.partial ? 10 : 0; index <= (options.incomplete ? 39 : 40); index++) {
    if (options.gap && index > 10 && index < 20) continue;
    if (options.suppressed && index === 20) pipeline.invalidateNativeDriverEvidence("f1-2025");
    if (index === 20) await options.onMidpoint?.();
    if (options.bindLater && index === 20) db.driverBindings = { revision: 1, bindings: [binding()] };
    if (options.rebindWithSwap && index === 20) db.driverBindings = {
      revision: 2, bindings: [{ ...binding(sourceActor("1", 8)), revision: 2 }],
    };
    const lapSeconds = index * 0.5;
    const networkId = options.stale && index > 10 ? null
      : options.other || (options.swap && index >= 15 && index < 25) || (options.rebindWithSwap && index >= 20) ? 8 : 7;
    const participant = options.participantCadence && index % (options.participantCadence * 2) !== 0 ? null : networkId;
    await pipeline.processPacket(next(100.00025 + lapSeconds, index === 40 ? 0 : lapSeconds, index === 40 ? 2 : 1, participant,
      { paused: options.paused, spectating: options.spectating, skipSession: options.staleSessionTail && index > 37 }));
  }
  await pipeline.finalizeCurrentSession();
  return db;
}

describe("native source -> live pipeline -> detector -> attribution persistence", () => {
  test("recording-off captures fractional same-domain bounds and closes only after attribution", async () => {
    const db = await capture();
    const lap = db.laps.find((value) => value.lapNumber === 1);
    expect(lap?.driverAttribution?.attribution).toBe("Self");
    expect(lap?.driverAttribution?.source).toEqual({ domain: "f1-2025-session:1", startMs: 100000.25, endMs: 120000.25 });
    expect(db.finalizedOriginalActivities).toEqual([1]);
    const stints = db.sessionAttribution.get(1)!;
    expect(stints.map((stint) => stint.attribution)).toEqual(["Self"]);
    expect(stints[0]!.endMs! - stints[0]!.startMs).toBe(20_000);
  });
  test("official five-second native participant cadence retains whole-lap Self coverage", async () => {
    const db = await capture({ participantCadence: 5 });
    expect(db.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Self");
    expect(db.sessionAttribution.get(1)?.map((stint) => stint.attribution)).toEqual(["Self"]);
  });
  test("native pause, spectator, and stale SESSION tail cannot certify a personal completion", async () => {
    for (const control of [{ paused: true }, { spectating: true }, { staleSessionTail: true }]) {
      const db = await capture(control);
      expect(db.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Unknown");
      expect(db.finalizedOriginalActivities).toEqual([1]);
    }
  });
  test("trusted candidates expire independently of native SDK time and frozen frames cannot renew them", () => {
    let controlNow = 1_000_000;
    const candidates = new NativeBindingCandidateCache(() => controlNow);
    const next = nativePackets();
    const first = next(100.00025, 0, 1);
    candidates.updateBindings({ revision: 0, bindings: [] });
    candidates.observeSource(first, getNativeSourceClock(first));
    const initial = candidates.listCandidates().candidates[0]!;
    expect(candidates.resolveCandidate(initial.candidateId, 0)?.nativeIdentity).toBe(encodeNativeDriverBinding(first.driverActor!));
    expect(candidates.resolveCandidate(initial.candidateId, 1)).toBeNull();
    controlNow += 2_000;
    expect(candidates.resolveCandidate(initial.candidateId, 0)).toBeNull();
    candidates.observeSource(first, getNativeSourceClock(first));
    expect(candidates.listCandidates().candidates).toEqual([]);
    const advanced = next(100.50025, 0.5, 1);
    candidates.observeSource(advanced, getNativeSourceClock(advanced));
    const renewed = candidates.listCandidates().candidates[0]!;
    expect(renewed.candidateId).not.toBe(initial.candidateId);
    candidates.updateBindings({ revision: 1, bindings: [binding()] });
    expect(candidates.resolveCandidate(renewed.candidateId, 0)).toBeNull();
    expect(candidates.listCandidates().candidates).toEqual([]);
  });
  test("native source/session change invalidates a candidate before normalized telemetry is ready", () => {
    const candidates = new NativeBindingCandidateCache(() => 1_000_000);
    const packet = nativePackets()(100.00025, 0, 1);
    candidates.updateBindings({ revision: 0, bindings: [] });
    candidates.observeSource(packet, getNativeSourceClock(packet));
    const candidate = candidates.listCandidates().candidates[0]!;
    const generation = new Uint32Array(candidates.sourceRevisionBuffer);
    const previous = Atomics.load(generation, 0);
    const header = Buffer.alloc(F1_HEADER_SIZE + 16);
    header.writeUInt16LE(2025, 0);
    header[2] = 25;
    header[5] = 1;
    header[6] = F1_PACKET_IDS.SESSION;
    header.writeBigUInt64LE(2n, 7);
    candidates.observeRawSource("f1-2025", header);
    expect(candidates.resolveCandidate(candidate.candidateId, 0)).toBeNull();
    expect(Atomics.load(generation, 0)).not.toBe(previous);
  });
  test("delayed or boundary-ambiguous pre-invalidation acquisition cannot resurrect current confirmation", () => {
    let controlNow = 1_000_000;
    const candidates = new NativeBindingCandidateCache(() => controlNow);
    const next = nativePackets();
    const first = next(100.00025, 0, 1);
    candidates.updateBindings({ revision: 0, bindings: [] });
    candidates.observeSource(first, getNativeSourceClock(first), controlNow);
    const initial = candidates.listCandidates().candidates[0]!;
    controlNow += 10;
    candidates.invalidate("f1-2025", controlNow);
    const delayed = next(100.10025, 0.1, 1);
    candidates.observeSource(delayed, getNativeSourceClock(delayed), controlNow - 1);
    expect(candidates.listCandidates().candidates).toEqual([]);
    candidates.observeSource(delayed, getNativeSourceClock(delayed), controlNow);
    expect(candidates.listCandidates().candidates).toEqual([]);
    expect(candidates.resolveCandidate(initial.candidateId, 0)).toBeNull();
    controlNow += 1;
    candidates.observeSource(delayed, getNativeSourceClock(delayed), controlNow);
    const current = candidates.listCandidates().candidates[0]!;
    expect(candidates.resolveCandidate(current.candidateId, 0)?.nativeIdentity).toBe(encodeNativeDriverBinding(delayed.driverActor!));
  });
  test("provisional resume completes the same durable row/GUID and exact original membership", async () => {
    const before = await getLocalGameBindingSnapshot();
    const prior = before.bindings.find((row) => row.gameId === "f1-2025");
    const fixture = { ...binding(), id: prior?.id ?? crypto.randomUUID(), revision: (prior?.revision ?? 0) + 1 };
    await upsertLocalGameBinding(fixture);
    const db = new RealDbAdapter({ sourceOrigin: { kind: "native_capture" }, notifyDriverProfile: false });
    const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), { bypassPacketRateFilter: true,
      skipHistorySeeding: true, skipDevState: true, enqueueSessionCaptureSplits: false, recorder: new NullSessionRecorderAdapter() });
    const next = nativePackets();
    let sessionId: number | undefined;
    try {
      for (let index = 0; index <= 20; index++) await pipeline.processPacket(next(100.00025 + index * 0.5, index * 0.5, 1));
      sessionId = pipeline.lapDetector!.session!.sessionId;
      await pipeline.lapDetector!.snapshotIncompleteLap!();
      const provisional = (await client.execute({ sql: "SELECT id,lap_guid FROM laps WHERE session_id=? AND lap_number=1", args: [sessionId] })).rows[0]!;
      const provisionalGuid = provisional.lap_guid;
      if (typeof provisionalGuid !== "string") throw new Error("Native provisional lap has no GUID");
      const stints = await listSessionDriverAttributionStints(sessionId);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      const competingWrite = withDatabaseTransaction(client, async (tx) => {
        await tx.execute({ sql: "UPDATE sessions SET is_favorite=1 WHERE id=?", args: [sessionId!] });
        entered.resolve();
        await release.promise;
      });
      let attributionWrite: Promise<void> | undefined;
      let restoreHooks: (() => void) | undefined;
      try {
        await Promise.race([entered.promise, competingWrite]);
        restoreHooks = installDatabaseWriteTestHooks({ waiting: () => waiting.resolve() });
        attributionWrite = db.setSessionDriverAttribution(sessionId, stints);
        await Promise.race([waiting.promise, attributionWrite.then(() => {
          throw new Error("Native attribution bypassed the competing database transaction");
        })]);
      } finally {
        release.resolve();
        try { await competingWrite; }
        finally {
          try { await attributionWrite; }
          finally { restoreHooks?.(); }
        }
      }
      expect((await client.execute({ sql: "SELECT is_favorite FROM sessions WHERE id=?", args: [sessionId] })).rows[0]?.is_favorite).toBe(1);
      expect(await listSessionDriverAttributionStints(sessionId)).toEqual(stints);
      for (let index = 21; index <= 40; index++) await pipeline.processPacket(next(100.00025 + index * 0.5,
        index === 40 ? 0 : index * 0.5, index === 40 ? 2 : 1));
      await pipeline.finalizeCurrentSession();
      const completed = (await client.execute({ sql: "SELECT id,lap_guid,lap_time FROM laps WHERE session_id=? AND lap_number=1", args: [sessionId] })).rows;
      expect(completed).toHaveLength(1);
      expect(completed[0]?.id).toBe(provisional.id);
      expect(completed[0]?.lap_guid).toBe(provisionalGuid);
      expect(completed[0]?.lap_time).toBe(20);
      expect((await readOriginalActivitySourceProof(sessionId))?.originalLapGuids).toEqual([provisionalGuid]);
    } finally {
      await pipeline.finalizeCurrentSession();
      if (sessionId !== undefined) await deleteSession(sessionId);
      const current = (await getLocalGameBindingSnapshot()).bindings.find((row) => row.gameId === "f1-2025");
      if (prior) await upsertLocalGameBinding({ ...prior, revision: (current?.revision ?? fixture.revision) + 1 });
      else await withDatabaseWrite(() => client.execute({ sql: "DELETE FROM local_game_bindings WHERE id=?", args: [fixture.id] }));
    }
  });
  test("original closure waits for pending lap follow-ups", async () => {
    const { promise: followupStarted, resolve: started } = Promise.withResolvers<void>();
    const { promise: followupReleased, resolve: release } = Promise.withResolvers<void>();
    const db = new class extends CapturingDbAdapter {
      override async getLapExperimentScope(lapId: number) {
        started();
        await followupReleased;
        return super.getLapExperimentScope(lapId);
      }
    }();
    const result = capture({ db });
    try {
      await Promise.race([followupStarted, result.then(() => {
        throw new Error("Original closed without entering lap follow-up work");
      })]);
      expect(db.finalizedOriginalActivities).toEqual([]);
    } finally {
      release();
      await result;
    }
    expect(db.finalizedOriginalActivities).toEqual([1]);
  });
  test("failed native lap storage holds its closed original without poisoning the next recording-off source", async () => {
    const snapshot = await getLocalGameBindingSnapshot();
    const prior = snapshot.bindings.find((value) => value.gameId === "f1-2025");
    const fixture = { ...binding(), id: prior?.id ?? crypto.randomUUID(), revision: (prior?.revision ?? 0) + 1 };
    await upsertLocalGameBinding(fixture);
    const db = new RealDbAdapter({ sourceOrigin: { kind: "native_capture" }, notifyDriverProfile: false });
    const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), { bypassPacketRateFilter: true,
      skipHistorySeeding: true, skipDevState: true, enqueueSessionCaptureSplits: false, recorder: new NullSessionRecorderAdapter() });
    const trigger = `native_attribution_fail_${crypto.randomUUID().replaceAll("-", "")}`;
    let firstSessionId: number | undefined, secondSessionId: number | undefined;
    try {
      const first = nativePackets("1");
      await pipeline.processPacket(first(100.00025, 0, 1));
      firstSessionId = pipeline.lapDetector!.session!.sessionId;
      await withDatabaseWrite(() => client.execute(`CREATE TRIGGER ${trigger} BEFORE INSERT ON laps
        WHEN NEW.session_id=${firstSessionId} BEGIN SELECT RAISE(FAIL,'native source write interrupted'); END`));
      for (let index = 1; index <= 40; index++) {
        await pipeline.processPacket(first(100.00025 + index * 0.5, index === 40 ? 0 : index * 0.5, index === 40 ? 2 : 1));
      }
      await expect(db.drainLapWrites(firstSessionId)).rejects.toMatchObject({ cause: { code: "SQLITE_CONSTRAINT", message: expect.stringContaining("native source write interrupted") } });
      await withDatabaseWrite(() => client.execute(`DROP TRIGGER ${trigger}`));
      const second = nativePackets("2");
      await pipeline.processPacket(second(200.00025, 0, 1));
      secondSessionId = pipeline.lapDetector!.session!.sessionId;
      expect(secondSessionId).not.toBe(firstSessionId);
      expect(await readOriginalActivitySourceProof(firstSessionId)).toBeNull();
      for (let index = 1; index <= 40; index++) {
        await pipeline.processPacket(second(200.00025 + index * 0.5, index === 40 ? 0 : index * 0.5, index === 40 ? 2 : 1));
      }
      await pipeline.finalizeCurrentSession();
      expect(await readOriginalActivitySourceProof(firstSessionId)).toBeNull();
      expect((await readOriginalActivitySourceProof(secondSessionId))?.coverage).toBe("complete");
    } finally {
      await withDatabaseWrite(() => client.execute(`DROP TRIGGER IF EXISTS ${trigger}`));
      await pipeline.finalizeCurrentSession();
      if (firstSessionId !== undefined) await deleteSession(firstSessionId);
      if (secondSessionId !== undefined) await deleteSession(secondSessionId);
      const current = (await getLocalGameBindingSnapshot()).bindings.find((value) => value.gameId === "f1-2025");
      if (prior) await upsertLocalGameBinding({ ...prior, revision: (current?.revision ?? fixture.revision) + 1 });
      else await withDatabaseWrite(() => client.execute({ sql: "DELETE FROM local_game_bindings WHERE id=?", args: [fixture.id] }));
    }
  });
  test("same display name never matches another native actor; native swap is Mixed", async () => {
    const other = await capture({ other: true });
    expect(other.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Other");
    const swapped = await capture({ swap: true });
    const proof = swapped.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution;
    expect(proof?.attribution).toBe("Mixed");
    expect(proof?.stints.map((stint) => stint.actor?.actorId)).toEqual(["1:network:7", "1:network:8", "1:network:7"]);
  });
  test("confirming another actor during the lap cannot turn a native driver swap into wholly Self", async () => {
    const db = await capture({ rebindWithSwap: true });
    const proof = db.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution;
    expect(proof?.stints.map((stint) => stint.attribution)).toEqual(["Self", "Self"]);
    expect(proof?.stints.map((stint) => stint.bindingSnapshot?.revision)).toEqual([1, 2]);
    expect(proof?.attribution).toBe("Mixed");
  });
  test("yesterday's session binding cannot establish Self today", async () => {
    const db = await capture({ sessionId: "2" });
    expect(db.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Unknown");
  });
  test("binding halfway through a lap preserves Unknown start and only measured subsequent Self time", async () => {
    const db = await capture({ bindLater: true });
    expect(db.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Unknown");
    expect(db.sessionAttribution.get(1)?.map((stint) => [stint.attribution, stint.startMs, stint.endMs])).toEqual([
      ["Unknown", 100000.25, 110000.25], ["Self", 110000.25, 120000.25],
    ]);
  });
  test("attaching mid-lap cannot credit the unobserved logical lap start", async () => {
    const db = await capture({ partial: true });
    expect(db.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Unknown");
    expect(db.sessionAttribution.get(1)?.every((stint) => stint.attribution === "Self")).toBe(true);
  });
  test("a closed source's unfinished lap remains Unknown while measured session control remains Self", async () => {
    const db = await capture({ incomplete: true });
    const lap = db.laps.find((value) => value.lapNumber === 1);
    expect(lap?.invalidReason).toBe("incomplete");
    expect(lap?.driverAttribution?.attribution).toBe("Unknown");
    expect(db.sessionAttribution.get(1)?.map((stint) => stint.attribution)).toEqual(["Self"]);
    expect(db.finalizedOriginalActivities).toEqual([1]);
  });
  test("missing/stale participant evidence and source gaps cannot establish a personal lap", async () => {
    const stale = await capture({ stale: true });
    expect(stale.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Unknown");
    const gap = await capture({ gap: true });
    expect(gap.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Unknown");
    // Missing native observations affect driver coverage, not the membership of bytes actually captured.
    expect(gap.finalizedOriginalActivities).toEqual([1]);
    const suppressed = await capture({ suppressed: true });
    expect(suppressed.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution?.attribution).toBe("Unknown");
    expect(suppressed.finalizedOriginalActivities).toEqual([1]);
  });
  test("verified account claiming during capture never substitutes the cloud account for the game actor", async () => {
    const before = await getLocalGameBindingSnapshot();
    const prior = before.bindings.find((value) => value.gameId === "f1-2025");
    const fixture = { ...binding(), id: prior?.id ?? crypto.randomUUID(), revision: (prior?.revision ?? 0) + 1 };
    await upsertLocalGameBinding(fixture);
    const db = new class extends CapturingDbAdapter {
      override getDriverBindings() { return getLocalGameBindingSnapshot(); }
    }();
    try {
      const cloudOwner = await getLocalAccountOwner() ?? "owner-a";
      await capture({ db, onMidpoint: () => claimLocalAccountOwner(cloudOwner) });
      const proof = db.laps.find((lap) => lap.lapNumber === 1)?.driverAttribution;
      expect(proof?.attribution).toBe("Self");
      expect(proof?.stints.map((stint) => stint.actor?.actorId)).toEqual(["1:network:7"]);
      expect((await getLocalGameBindingSnapshot()).bindings.find((value) => value.gameId === "f1-2025"))
        .toEqual(fixture);
      expect(proof?.stints[0]?.bindingSnapshot).toEqual(fixture);
      await upsertLocalGameBinding({ ...fixture,
        nativeIdentity: encodeNativeDriverBinding(sourceActor("2", 8)), revision: fixture.revision + 1 });
      expect(proof?.stints[0]?.bindingSnapshot).toEqual(fixture);
      expect(classifyLapAttribution(proof!.stints, proof!.source.startMs, proof!.source.endMs, proof!.source.domain)).toBe("Self");
    } finally {
      const current = (await getLocalGameBindingSnapshot()).bindings.find((value) => value.gameId === "f1-2025");
      if (prior) await upsertLocalGameBinding({ ...prior, revision: (current?.revision ?? fixture.revision) + 1 });
      else await client.execute({ sql: "DELETE FROM local_game_bindings WHERE id=?", args: [fixture.id] });
    }
  });
  test("native Other/AI roles cannot be confirmed as Self; valid local-role binding keeps positive Other", () => {
    const role: NativeDriverActor = { gameId: "ac-evo", source: "ac-evo-shared-memory", actorId: "ac-evo-control:other",
      bindingScope: "installation", sessionId: "ac-evo-player-car:00000001000000020000000300000004",
      clockDomain: "ac-evo-capture-utc-ms", observedAtMs: 100000.25 };
    const local = { id: "evo-local", gameId: "ac-evo", sourceKind: role.source, revision: 1,
      confirmation: "native_verified" as const,
      nativeIdentity: JSON.stringify({ schemaVersion: 1, actorId: "ac-evo-control:local-player", bindingScope: "installation" }) };
    const bad = { ...local, confirmation: "user_confirmed" as const, nativeIdentity: encodeNativeDriverBinding(role) };
    expect(validateNativeDriverBinding(bad)).toBe(false);
    const next = nativePackets();
    const first: TelemetryPacket = { ...next(100.00025, 0, 1), gameId: "ac-evo", sessionUID: undefined, driverActor: role };
    const last: TelemetryPacket = { ...next(100.10025, 0.1, 1), gameId: "ac-evo", sessionUID: undefined,
      driverActor: { ...role, observedAtMs: 100100.25 } };
    const tracker = new NativeAttributionTracker();
    const bindings = nativeDriverBindings([local]);
    tracker.observe(first, bindings, 100000.25);
    tracker.observe(last, bindings, 100100.25);
    expect(captureLapDriverAttribution([first], last)?.attribution).toBe("Other");
    const unbound = new NativeAttributionTracker();
    unbound.observe(first, nativeDriverBindings([bad]), 100000.25);
    unbound.observe(last, nativeDriverBindings([bad]), 100100.25);
    expect(captureLapDriverAttribution([first], last)?.attribution).toBe("Unknown");
  });
  test("inactive source samples never extend fresh cached actor evidence as Self", () => {
    const next = nativePackets();
    const first = next(100.00025, 0, 1);
    const last = next(101.00025, 1, 1);
    first.IsRaceOn = 0;
    last.IsRaceOn = 0;
    const tracker = new NativeAttributionTracker();
    const bindings = nativeDriverBindings([binding()]);
    tracker.observe(first, bindings);
    tracker.observe(last, bindings);
    expect(captureLapDriverAttribution([first], last)?.attribution).toBe("Unknown");
  });
  test("captured proof is immutable across later local binding/account-independent changes", async () => {
    const next = nativePackets();
    const tracker = new NativeAttributionTracker();
    const bindings = nativeDriverBindings([binding()]);
    const first = next(100.00025, 0, 1);
    const last = next(101.00025, 1, 1);
    tracker.observe(first, bindings);
    tracker.observe(last, bindings);
    const captured = captureLapDriverAttribution([first], last)!;
    bindings[0]!.actorId = "1:network:999";
    bindings[0]!.revision = 20;
    expect(captured.attribution).toBe("Self");
    expect(captured.stints[0]?.bindingRevision).toBe(1);
    const reset = next(99.00025, 0, 1);
    tracker.observe(reset, bindings);
    const afterReset = next(100.00025, 1, 1);
    tracker.observe(afterReset, bindings);
    expect(captureLapDriverAttribution([reset], afterReset)?.attribution).toBe("Unknown");
    expect(tracker.sourceComplete).toBe(false);
  });
});
