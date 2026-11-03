import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../../../../test/artifacts/sessions/ams2-fixtures.json";
import { readAMS2DumpFrames } from "@raceiq/capture-formats/ams2/dump";
import { CapturingDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { getLastParsedFrameSequence, parsePacket, materializeParserInitializationPlan, replayParserInitializationPlan, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import { registerGame } from "@raceiq/shared/games/registry";
import { ams2ServerAdapter } from "../../src/index";
import { AMS2TelemetrySource } from "../../src/source";
import { AMS2_LAYOUT as L, AMS2_MEMORY_SIZE, PARTICIPANT_OFFSET as P, PARTICIPANT_SIZE } from "../../src/layout";
import { decodeAMS2Frame, encodeAMS2Frame } from "../../src/frame";
registerServerGame(ams2ServerAdapter);

registerGame(ams2ServerAdapter);

async function replay(name: string) {
  const fixturePath = resolve(import.meta.dir, "../../../../test/artifacts/sessions", `ams2-${name}.bin.gz`);
  const provenance = manifest.find(fixture => fixture.name === name)!;
  expect(provenance).toBeDefined();
  const compressed = readFileSync(fixturePath);
  expect(compressed.length).toBe(provenance.bytes);
  expect(compressed.length).toBeLessThan(100_000_000);
  expect(createHash("sha256").update(compressed).digest("hex")).toBe(provenance.sha256);
  const channels = {
    Speed: { min: Infinity, max: -Infinity },
    Accel: { min: Infinity, max: -Infinity },
    Brake: { min: Infinity, max: -Infinity },
    CurrentEngineRpm: { min: Infinity, max: -Infinity },
    PositionX: { min: Infinity, max: -Infinity },
    PositionZ: { min: Infinity, max: -Infinity },
  };
  const gears = new Set<number>();
  const db = new CapturingDbAdapter();
  const detector = ams2ServerAdapter.createLapDetector({ db });
  const parserState = ams2ServerAdapter.createParserState();
  let memory: Buffer | null = null;
  let ended = 0;
  const source = new AMS2TelemetrySource({
    reader: { start() {}, async stop() {}, readLatest: () => memory },
    registerIdentity: async () => {},
    onSessionEnd: async () => { ended++; await detector.finalizeCurrentSession?.(); },
    dispatchRawFrame: async raw => {
      const packet = ams2ServerAdapter.tryParse(raw, parserState);
      if (packet) {
        expect(packet.gameId).toBe("ams2");
        expect(packet.TimestampMS).toBe(raw.readDoubleLE(8));
        for (const key of Object.keys(channels) as Array<keyof typeof channels>) {
          const value = packet[key];
          if (!Number.isFinite(value)) throw new Error(`${name}: non-finite ${key}`);
          channels[key].min = Math.min(channels[key].min, value);
          channels[key].max = Math.max(channels[key].max, value);
        }
        gears.add(packet.Gear);
        await detector.feed(packet);
      }
    },
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let acquisitionTime = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => acquisitionTime);
  try {
    let frameCount = 0;
    let previousAcquisitionTime = -Infinity;
    for await (const raw of readAMS2DumpFrames(fixturePath)) {
      frameCount++;
      memory = raw.subarray(24);
      acquisitionTime = raw.readDoubleLE(8);
      expect(acquisitionTime).toBeGreaterThan(0);
      expect(acquisitionTime).toBeGreaterThanOrEqual(previousAcquisitionTime);
      previousAcquisitionTime = acquisitionTime;
      expect(memory.length).toBe(AMS2_MEMORY_SIZE);
      // Committed fixtures must never contain participant names.
      for (let i = 0; i < 64; i++) {
        const start = P + i * PARTICIPANT_SIZE + 1;
        if (memory.subarray(start, start + 64).some(byte => byte !== 0)) throw new Error("Participant name in fixture");
      }
      await source.pollOnce();
    }
    // Finalisation must come from the real menu frame, before artificial EOF handling.
    expect(frameCount).toBe(provenance.fixtureFrames);
    expect(ended).toBeGreaterThan(0);
    expect(detector.session).toBeNull();
    const messages = log.mock.calls.map(call => call.map(String).join(" "));
    const saved = db.laps.filter(lap => lap.invalidReason !== "incomplete");
    expect(new Set(saved.map(lap => `${lap.sessionId}:${lap.lapNumber}`)).size).toBe(saved.length);
    expect(messages.filter(message => message.startsWith("[Lap] Saved lap "))).toHaveLength(saved.length);
    for (const lap of db.laps) {
      expect(lap.sessionId).toBeGreaterThan(0);
      expect(lap.sessionId).toBeLessThanOrEqual(db.sessions.length);
      expect(lap.isValid).toBe(lap.invalidReason === null);
    }
    return { db, diagnostics: source.getDiagnostics(), messages, channels, gears };
  } finally {
    await source.stop();
    await detector.finalizeCurrentSession?.();
    log.mockRestore();
    warn.mockRestore();
    clock.mockRestore();
  }
}

const completed = (db: CapturingDbAdapter, sessionId = 1) =>
  db.laps.filter(lap => lap.sessionId === sessionId && lap.invalidReason !== "incomplete");

describe("AMS2 real raw-dump fixtures", () => {
  test("Time Trial preserves timed laps and classifies both untimed crossings", async () => {
    const { db, messages } = await replay("time-trial");
    expect(db.sessions.map(s => s.sessionType)).toEqual(["practice"]);
    const laps = completed(db);
    expect(laps.map(lap => lap.lapNumber)).toEqual([1, 2, 3]);
    expect(laps.map(l => l.classification)).toEqual(["out_lap", "pace", "pace"]);
    expect(laps.map(l => l.lapTime.toFixed(3))).toEqual(["50.460", "52.080", "51.300"]);
    expect(messages.filter(m => m.includes("Untimed start-line crossing"))).toHaveLength(2);
    expect(messages.filter(m => m.includes("Race restart detected"))).toHaveLength(0);
  });

  test("race grid-start is valid while actual pit laps and cooldown remain excluded", async () => {
    const { db, channels, gears } = await replay("race-pit-stop");
    expect(completed(db).map(lap => lap.lapNumber)).toEqual([1, 2, 3, 4, 5]);
    // Broad physical ranges and variation catch flat/replaced channels without
    // claiming an independently observed calibration or exact in-game value.
    expect(channels.Speed.min).toBeGreaterThanOrEqual(0);
    expect(channels.Speed.max).toBeLessThan(150); // metres per second
    expect(channels.Speed.max - channels.Speed.min).toBeGreaterThan(10);
    for (const channel of [channels.Accel, channels.Brake]) {
      expect(channel.min).toBeGreaterThanOrEqual(0);
      expect(channel.max).toBeLessThanOrEqual(255);
      expect(channel.max - channel.min).toBeGreaterThan(100);
    }
    expect(channels.CurrentEngineRpm.min).toBeGreaterThanOrEqual(0);
    expect(channels.CurrentEngineRpm.max).toBeLessThan(25_000);
    expect(channels.CurrentEngineRpm.max - channels.CurrentEngineRpm.min).toBeGreaterThan(1000);
    expect(gears.size).toBeGreaterThan(2);
    expect(channels.PositionX.max - channels.PositionX.min).toBeGreaterThan(100);
    expect(channels.PositionZ.max - channels.PositionZ.min).toBeGreaterThan(100);
    expect(db.sessions.map(s => s.sessionType)).toEqual(["race"]);
    expect(completed(db).map(l => l.classification)).toEqual(["pace", "pace", "in_lap", "out_lap", "pace"]);
    expect(completed(db).map(l => l.lapTime.toFixed(3))).toEqual(["84.850", "72.645", "112.819", "70.170", "66.820"]);
    expect(db.laps.at(-1)?.invalidReason).toBe("incomplete");
  });

  test("healthy qualifying retains three valid timed laps", async () => {
    const { db, diagnostics } = await replay("qualifying");
    expect(db.sessions.map(s => s.sessionType)).toEqual(["qualifying", "race"]);
    expect(completed(db).map(lap => lap.lapNumber)).toEqual([1, 2, 3, 4]);
    expect(completed(db).map(l => l.classification)).toEqual(["out_lap", "pace", "pace", "pace"]);
    expect(completed(db).map(l => l.lapTime.toFixed(3))).toEqual(["65.396", "65.371", "65.738", "65.478"]);
    expect(diagnostics.staleTransition).toBe(1);
    expect(db.laps.at(-1)?.invalidReason).toBe("incomplete");
  });

  test("weekend transitions do not create a leftover qualifying session", async () => {
    const { db, diagnostics } = await replay("weekend-sparse-qualifying");
    expect(db.sessions.map(s => s.sessionType)).toEqual(["practice", "qualifying", "race"]);
    expect(diagnostics.staleTransition).toBe(1);
    expect(completed(db, 3).map(l => l.invalidReason)).toEqual([null, null, null, null, null]);
    // The old dump already has missing qualifying samples: do not invent valid laps.
    expect(completed(db, 2).map(l => l.invalidReason)).toEqual([
      "game-invalidated", "too few telemetry packets", "too few telemetry packets", "too few telemetry packets",
    ]);
    expect(db.laps.at(-1)?.invalidReason).toBe("incomplete");
  });
  test("raw qualifying import rejects stale transition in both parser paths and matches live recording", async () => {
    const fixturePath = resolve(import.meta.dir, "../../../../test/artifacts/sessions", "ams2-qualifying.bin.gz");
    const db = new CapturingDbAdapter();
    const detector = ams2ServerAdapter.createLapDetector({ db });
    const parserState = ams2ServerAdapter.createParserState();
    let staleBytes: Buffer | null = null;
    let staleSessionState: number | null = null;
    let genuineResetAccepted = false;
    let previousAcceptedSessionState: number | null = null;
    try {
      for await (const raw of readAMS2DumpFrames(fixturePath)) {
        const original = Buffer.from(raw);
        const sessionState = raw.readUInt32LE(24 + L.mSessionState);
        const raceState = raw.readUInt32LE(24 + L.mRaceState);
        const isStaleTransition = previousAcceptedSessionState !== null &&
          sessionState !== previousAcceptedSessionState && raceState === 3 &&
          raw.readFloatLE(24 + L.mLastLapTime) > 0 &&
          raw.readFloatLE(24 + L.mCurrentTime) > 0;
        if (isStaleTransition && staleBytes === null) {
          staleBytes = original;
          staleSessionState = sessionState;
          const checkpoint = ams2ServerAdapter.captureParserCheckpoint!(parserState)!;
          const parseState = ams2ServerAdapter.restoreParserCheckpoint!(ams2ServerAdapter.createParserState(), checkpoint)!;
          const lapIndexState = ams2ServerAdapter.restoreParserCheckpoint!(ams2ServerAdapter.createParserState(), checkpoint)!;
          expect(ams2ServerAdapter.tryParse(raw, parseState)).toBeNull();
          expect(ams2ServerAdapter.tryParseLapIndex(raw, lapIndexState)).toBeNull();
        }
        const packet = ams2ServerAdapter.tryParse(raw, parserState);
        if (packet) {
          previousAcceptedSessionState = sessionState;
          if (staleSessionState !== null && sessionState === staleSessionState && raceState !== 3) genuineResetAccepted = true;
          await detector.feed(packet);
        }
        expect(raw).toEqual(original);
      }
      await detector.finalizeCurrentSession?.();
      const live = await replay("qualifying");
      expect(staleBytes).not.toBeNull();
      expect(genuineResetAccepted).toBe(true);
      expect(db.sessions.map(session => session.sessionType)).toEqual(live.db.sessions.map(session => session.sessionType));
      expect(db.laps.map(lap => [lap.sessionId, lap.lapNumber, lap.lapTime, lap.invalidReason]))
        .toEqual(live.db.laps.map(lap => [lap.sessionId, lap.lapNumber, lap.lapTime, lap.invalidReason]));
    } finally {
      await detector.finalizeCurrentSession?.();
    }
  });

  test("independent epochs preserve finished sessions through parsing, checkpoints, priming and import", async () => {
    let memory: Buffer | null = null;
    for await (const raw of readAMS2DumpFrames(resolve(import.meta.dir, "../../../../test/artifacts/sessions/ams2-qualifying.bin.gz"))) {
      if (ams2ServerAdapter.tryParse(raw, ams2ServerAdapter.createParserState())) {
        memory = Buffer.from(decodeAMS2Frame(raw)!.memory);
        break;
      }
    }
    if (!memory) throw new Error("No driving frame in qualifying fixture");
    const frame = (epoch: number, session: number, race: number, game = 2, timestamp = 1000) => {
      const snapshot = Buffer.from(memory);
      snapshot.writeUInt32LE(game, L.mGameState);
      snapshot.writeUInt32LE(session, L.mSessionState);
      snapshot.writeUInt32LE(race, L.mRaceState);
      return encodeAMS2Frame(snapshot, timestamp, epoch);
    };
    const qualifying = frame(0xffff_ffff, 3, 2);
    const menu = frame(0xffff_ffff, 3, 3, 1, 1500);
    const staleRace = frame(0xffff_ffff, 5, 3);
    const finishedRace = frame(0, 5, 3, 2, 2000);
    for (const parse of [ams2ServerAdapter.tryParse, ams2ServerAdapter.tryParseLapIndex]) {
      const state = ams2ServerAdapter.createParserState();
      expect(JSON.parse(parse(qualifying, state)!.sessionUID!).slice(0, 2)).toEqual([0xffff_ffff, 3]);
      expect(parse(menu, state)).toBeNull();
      const checkpoint = ams2ServerAdapter.captureParserCheckpoint!(state)!;
      const restored = ams2ServerAdapter.restoreParserCheckpoint!(null, checkpoint)!;
      expect(parse(staleRace, restored)).toBeNull();
      expect(JSON.parse(parse(finishedRace, restored)!.sessionUID!).slice(0, 2)).toEqual([0, 5]);
      const resumed = ams2ServerAdapter.restoreParserCheckpoint!(null, ams2ServerAdapter.captureParserCheckpoint!(restored)!)!;
      expect(parse(frame(0, 3, 3), resumed)).toBeNull();
    }
    const primed = ams2ServerAdapter.createParserState();
    ams2ServerAdapter.primeParserState(qualifying, primed);
    ams2ServerAdapter.primeParserState(staleRace, primed);
    expect(ams2ServerAdapter.tryParse(staleRace, primed)).toBeNull();
    ams2ServerAdapter.primeParserState(finishedRace, primed);
    const restoredPrime = ams2ServerAdapter.restoreParserCheckpoint!(null, ams2ServerAdapter.captureParserCheckpoint!(primed)!)!;
    expect(ams2ServerAdapter.tryParse(frame(0, 3, 3), restoredPrime)).toBeNull();
    expect(ams2ServerAdapter.tryParse(finishedRace, restoredPrime)?.ams2?.sessionType).toBe("race");

    expect(ams2ServerAdapter.tryParse(finishedRace, ams2ServerAdapter.restoreParserCheckpoint!(null, new Uint8Array())!)?.ams2?.sessionType).toBe("race");
    const legacy = new Uint8Array([1, 3, 0, 0, 0]);
    const legacyState = ams2ServerAdapter.restoreParserCheckpoint!(null, legacy)!;
    expect(ams2ServerAdapter.tryParse(staleRace, legacyState)).toBeNull();
    expect(ams2ServerAdapter.tryParse(qualifying, legacyState)?.ams2?.sessionType).toBe("qualifying");
    expect(ams2ServerAdapter.tryParse(finishedRace, legacyState)?.ams2?.sessionType).toBe("race");
    expect(ams2ServerAdapter.restoreParserCheckpoint!(null, new Uint8Array([1, 3, 0]))).toBeNull();

    const result = await importSessionFrames([qualifying, menu, finishedRace, frame(0, 5, 3, 1, 2500)], "ams2", { notifyDriverProfile: false });
    expect(result.packetCount).toBe(2);
    expect(result.sessionIds).toHaveLength(2);
  });

  test("stateful parser source captures replayable pre-frame checkpoints", async () => {
    const fixturePath = resolve(import.meta.dir, "../../../../test/artifacts/sessions", "ams2-qualifying.bin.gz");
    resetParserState("ams2");
    const locators = new Map<number, NonNullable<Parameters<typeof materializeParserInitializationPlan>[0]>>();
    const frames = new Map<number, Buffer>();
    const unsubscribe = subscribeParserSource(input => {
      if (input.locator) locators.set(input.sequence, input.locator);
    });
    try {
      let targetSequence: number | null = null;
      for await (const frame of readAMS2DumpFrames(fixturePath)) {
        const packet = parsePacket(frame);
        const sequence = getLastParsedFrameSequence();
        if (packet && sequence) {
          frames.set(sequence.sequence, frame);
          if (targetSequence === null) targetSequence = sequence.sequence;
          else if (sequence.sequence - targetSequence <= 2) {
            targetSequence = sequence.sequence;
            break;
          }
        }
      }
      expect(targetSequence).not.toBeNull();
      const locator = locators.get(targetSequence!);
      expect(locator).toBeDefined();
      const plan = materializeParserInitializationPlan(locator!);
      expect(plan).not.toBeNull();
      const checkpoint = replayParserInitializationPlan(plan!);
      expect(checkpoint).not.toBeNull();
      const restored = ams2ServerAdapter.restoreParserCheckpoint!(ams2ServerAdapter.createParserState(), checkpoint!);
      expect(restored).not.toBeNull();
      expect(ams2ServerAdapter.tryParse(frames.get(targetSequence!)!, restored)).not.toBeNull();
    } finally {
      unsubscribe();
      resetParserState("ams2");
    }
  });
});
