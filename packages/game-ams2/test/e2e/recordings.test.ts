import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../../../../test/artifacts/sessions/ams2-fixtures.json";
import { readAMS2DumpFrames } from "@raceiq/capture-formats/ams2/dump";
import { CapturingDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { registerGame } from "@raceiq/shared/games/registry";
import { ams2ServerAdapter } from "../../src/index";
import { AMS2TelemetrySource } from "../../src/source";
import { AMS2_MEMORY_SIZE, PARTICIPANT_OFFSET as P, PARTICIPANT_SIZE } from "../../src/layout";

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
  let memory: Buffer | null = null;
  let ended = 0;
  const source = new AMS2TelemetrySource({
    reader: { start() {}, async stop() {}, readLatest: () => memory },
    registerIdentity: async () => {},
    onSessionEnd: async () => { ended++; await detector.finalizeCurrentSession?.(); },
    dispatchRawFrame: async raw => {
      const packet = ams2ServerAdapter.tryParse(raw, null);
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
    expect(laps.map(l => l.invalidReason)).toEqual(["outlap", null, null]);
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
    expect(completed(db).map(l => l.invalidReason)).toEqual([null, null, "inlap", "outlap", null]);
    expect(completed(db).map(l => l.lapTime.toFixed(3))).toEqual(["84.850", "72.645", "112.819", "70.170", "66.820"]);
    expect(db.laps.at(-1)?.invalidReason).toBe("incomplete");
  });

  test("healthy qualifying retains three valid timed laps", async () => {
    const { db, diagnostics } = await replay("qualifying");
    expect(db.sessions.map(s => s.sessionType)).toEqual(["qualifying", "race"]);
    expect(completed(db).map(lap => lap.lapNumber)).toEqual([1, 2, 3, 4]);
    expect(completed(db).map(l => l.invalidReason)).toEqual(["outlap", null, null, null]);
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
});
