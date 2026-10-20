import { describe, expect, test, spyOn } from "bun:test";
import { LMUTelemetrySource } from "../src/source";
import { LmuSupplementalRest } from "../src/supplemental-rest";
import { normalizeLMUSourceFrame } from "../src/normalizer";
import { encodeLMUSourceFrame, decodeLMUSourceFrame, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY_INFO_SIZE, LMU_TELEMETRY, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE, LMU_SCORING_VEHICLE_SIZE } from "@raceiq/capture-formats/lmu/layout";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import { isLiveTelemetryFrameMessageV1 } from "@raceiq/shared/telemetry/live/contracts";
import { encodeLmuContext, decodeLmuContext } from "@raceiq/shared/telemetry/lmu-context";
import type { LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { encodeFrameLength, iterateSessionCaptureRecords, iterateSessionCaptureRecordsAsync } from "@raceiq/capture-formats/session/framing";

function playerMemory(): Buffer {
  const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
  memory.writeInt32LE(42, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.id);
  memory.writeDoubleLE(10, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
  memory.writeDoubleLE(8000, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineRpm);
  memory.writeDoubleLE(430, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineTorque);
  memory.writeDoubleLE(95, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineWaterTemp);
  memory.writeDoubleLE(64, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.electricBoostMotorTemperature);
  memory.writeDoubleLE(57, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.electricBoostMotorTorque);
  memory.writeUInt8(2, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.electricBoostMotorState);
  memory.writeDoubleLE(-6.25, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.steeringShaftTorque);
  memory.writeDoubleLE(0.25, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.batteryChargeFraction);
  memory.writeFloatLE(72, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.stateOfCharge);
  memory.writeFloatLE(0.63, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.virtualEnergy);
  memory.writeFloatLE(-80, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.regenKw);
  memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  memory.writeUInt8(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.inRealtime);
  memory.writeDoubleLE(0.4, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.averagePathWetness);
  memory.writeInt32LE(42, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.id);
  memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
  memory.writeInt16LE(2, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.penaltyCount);
  return memory;
}

describe("LMU Phase 1 player pipeline", () => {
  test("projects independent native energy and double-precision player channels with honest invalid and zero states", () => {
    const memory = playerMemory();
    const frame = decodeLMUSourceFrame(encodeLMUSourceFrame(memory, 1000)!)!;
    const packet = normalizeLMUSourceFrame(frame);
    const projector = new LiveTelemetryProjector();
    const result = projector.project({ packet, receivedAtMs: 1000 });
    const schema = result.schema!;
    const value = (id: string) => result.frame!.values[schema.definitions.findIndex((entry) => entry.semanticId === id)];
    expect(value("fuel.battery-charge-fraction")).toBe(0.25);
    expect(value("fuel.state-of-charge")).toBe(72);
    expect(value("fuel.virtual-energy")).toBeCloseTo(0.63);
    expect(value("diagnostics.regen-kw")).toBe(-80);
    expect(value("engine.water-temperature")).toBe(95);
    expect(value("hybrid.motor.temperature")).toBe(64);
    expect(value("hybrid.motor.torque")).toBe(57);
    expect(value("engine.torque")).toBe(430);
    expect(value("steering.shaft-torque")).toBe(-6.25);
    expect(value("weather.average-path-wetness")).toBe(0.4);
    expect(value("weather.rain-intensity")).toBe(0);
    expect(value("electronics.traction-control-level")).toBe(0);
    expect(value("electronics.abs-level")).toBe(0);
    expect(value("race.penalty-count")).toBe(2);
    expect(schema.definitions.find((entry) => entry.semanticId === "fuel.state-of-charge")?.unit).toBe("%");
    expect(schema.definitions.find((entry) => entry.semanticId === "fuel.virtual-energy")?.unit).toBe("fraction");
    expect(schema.definitions.find((entry) => entry.semanticId === "diagnostics.regen-kw")?.unit).toBe("kW");
    expect(isLiveTelemetryFrameMessageV1(JSON.parse(JSON.stringify(result.frame)), schema)).toBe(true);
    memory.writeFloatLE(NaN, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.virtualEnergy);
    memory.writeDoubleLE(0, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.batteryChargeFraction);
    const invalid = projector.project({ packet: normalizeLMUSourceFrame(decodeLMUSourceFrame(encodeLMUSourceFrame(memory, 1010)!)!), receivedAtMs: 1010 }).frame!;
    const energy = schema.definitions.findIndex((entry) => entry.semanticId === "fuel.virtual-energy");
    expect(invalid.values[energy]).toBeNull();
    expect(invalid.states?.[energy]).toBe("invalid");
    expect(invalid.values[schema.definitions.findIndex((entry) => entry.semanticId === "fuel.battery-charge-fraction")]).toBe(0);
  });

  test("invalidates no-player, duplicate identity, rewind and frozen snapshots without guessing a player", async () => {
    let now = 10000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const memory = playerMemory();
    const contexts: LmuLiveContext[] = [];
    const frames: Buffer[] = [];
    const source = new LMUTelemetrySource({ rest: false, reader: { start() {}, async stop() {}, readLatest: () => memory }, dispatchRawFrame: async (frame) => { frames.push(frame); }, publishUnavailable: (context) => { contexts.push(context); } });
    try {
      expect(await source.pollOnce()).toBe(true);
      const firstKey = decodeLMUSourceFrame(frames[0]!)!.lmuContext!.key.sessionKey;
      memory.writeDoubleLE(1, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
      expect(await source.pollOnce()).toBe(true);
      expect(decodeLMUSourceFrame(frames[1]!)!.lmuContext!.key.sessionKey).not.toBe(firstKey);
      now += 1001;
      expect(await source.pollOnce()).toBe(false);
      expect(contexts.at(-1)?.status).toBe("unavailable");
      memory.writeUInt8(0, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
      expect(await source.pollOnce()).toBe(false);
      memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
      memory.copy(memory, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE_SIZE);
      memory.writeInt32LE(2, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
      expect(await source.pollOnce()).toBe(false);
      expect(frames).toHaveLength(2);
    } finally { await source.stop(); clock.mockRestore(); }
  });

  test("invalidates ambiguous telemetry, garage and pause, and rotates generation after slot and vehicle changes", async () => {
    const memory = playerMemory();
    const frames: Buffer[] = [];
    const unavailable: LmuLiveContext[] = [];
    const source = new LMUTelemetrySource({ rest: false, reader: { start() {}, async stop() {}, readLatest: () => memory }, dispatchRawFrame: async (frame) => { frames.push(frame); }, publishUnavailable: (context) => { unavailable.push(context); } });
    const lastContext = () => decodeLMUSourceFrame(frames.at(-1)!)!.lmuContext!;
    try {
      expect(await source.pollOnce()).toBe(true);
      const initialKey = lastContext().key.sessionKey;
      memory.copy(memory, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY_INFO_SIZE, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY_INFO_SIZE);
      memory.writeUInt8(2, LMU_TELEMETRY_HEADER_OFFSET);
      memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 1);
      expect(await source.pollOnce()).toBe(false);
      expect(unavailable.at(-1)?.status).toBe("unavailable");
      memory.writeInt32LE(7, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.id);
      expect(await source.pollOnce()).toBe(true);
      const slotKey = lastContext().key.sessionKey;
      expect(slotKey).not.toBe(initialKey);
      memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.inGarageStall);
      expect(await source.pollOnce()).toBe(false);
      memory.writeUInt8(0, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.inGarageStall);
      memory.writeUInt8(9, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.gamePhase);
      expect(await source.pollOnce()).toBe(false);
      memory.writeUInt8(0, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.gamePhase);
      memory.writeInt32LE(84, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY_INFO_SIZE + LMU_TELEMETRY.id);
      memory.writeInt32LE(84, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.id);
      expect(await source.pollOnce()).toBe(true);
      expect(lastContext().playerVehicleId).toBe(84);
      expect(lastContext().key.sessionKey).not.toBe(slotKey);
    } finally { await source.stop(); }
  });

  test("does not restore a lost player identity while previously queued frames finish", async () => {
    const memory = playerMemory();
    memory.write("Ferrari 499P", LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.vehicleName);
    memory.write("Circuit de la Sarthe", LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.trackName);
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    let dispatched = 0;
    const source = new LMUTelemetrySource({
      rest: false,
      reader: { start() {}, async stop() {}, readLatest: () => memory },
      dispatchRawFrame: async () => {
        if (++dispatched === 1) { firstStarted.resolve(); await firstGate.promise; }
        else { secondStarted.resolve(); await secondGate.promise; }
      },
    });
    const first = source.pollOnce();
    await firstStarted.promise;
    expect(source.currentIdentity?.carName).toBe("Ferrari 499P");
    memory.writeDoubleLE(11, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
    const second = source.pollOnce();
    memory.writeUInt8(0, LMU_TELEMETRY_HEADER_OFFSET + 2);
    const invalidated = source.pollOnce();
    firstGate.resolve();
    await secondStarted.promise;
    try { expect(source.currentIdentity).toBeNull(); }
    finally {
      secondGate.resolve();
      await Promise.all([first, second, invalidated]);
      await source.stop();
    }
  });

  test("acquires REST independently, preserves unchanged source time, reports errors, and rejects old-generation completions", async () => {
    let mode: "ok" | "error" | "malformed" | "delayed" = "ok";
    let now = 1000;
    let release: (() => void) | undefined;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (mode === "delayed" && path.includes("RepairAndRefuel")) {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      if (mode === "error") return new Response("failed", { status: 503 });
      if (mode === "malformed") return new Response("not JSON");
      if (path === "/rest/sessions") return Response.json({ SESSSET_race_timescale: { currentValue: 2 }, SESSSET_private_qual: { currentValue: 0 } });
      if (path.includes("RepairAndRefuel")) return Response.json({ wearables: { body: { aero: 0 }, brakes: [0.1, 0.2, 0.3, 0.4], suspension: [0, 0, 0, 0] }, fuelInfo: { maxVirtualEnergy: 123 } });
      if (path.includes("getPlayerGarageData")) return Response.json({ VM_STEER_LOCK: { stringValue: "16.5 deg" } });
      return Response.json({});
    } });
    const poller = new LmuSupplementalRest({ baseUrl: `http://127.0.0.1:${server.port}`, now: () => now, timeoutMs: 1000 });
    const sample = (id: string) => poller.snapshot().find((entry) => entry.semanticId === id)!;
    try {
      poller.activate({ sessionKey: "first", vehicleId: 42 });
      await poller.refresh();
      expect(sample("lmu.rest.session.private-qualifying").observation.value).toBe(false);
      const wire = encodeLmuContext({ schemaVersion: 1, key: { sessionKey: "first", captureSequence: "1", frameTime: { domain: "wall-clock", milliseconds: now } }, playerVehicleId: 42, status: "active", supplemental: poller.snapshot() });
      const malformedFreshness = structuredClone(wire);
      (malformedFreshness.supplemental[0]!.observation as unknown as Record<string, unknown>).freshness = ["fresh"];
      expect(decodeLmuContext(malformedFreshness)).toBeNull();
      expect(sample("lmu.rest.condition.aero").observation.value).toBe(0);
      expect(sample("lmu.rest.energy.capacity").observation).toMatchObject({ value: null, state: "not-applicable" });
      const original = sample("lmu.rest.condition.aero").observation.provenance;
      now += 1001;
      await poller.refresh();
      expect(sample("lmu.rest.condition.aero").acquiredAt).toEqual({ domain: "wall-clock", milliseconds: now });
      expect(sample("lmu.rest.condition.aero").observation.provenance).toEqual(original);
      mode = "error";
      now += 1001;
      await poller.refresh();
      expect(sample("lmu.rest.condition.aero").observation.state).toBe("error");
      expect(sample("lmu.rest.condition.aero").observation.provenance).toEqual(original);
      expect(sample("lmu.rest.condition.aero").acquiredAt).toEqual({ domain: "wall-clock", milliseconds: 2001 });
      mode = "malformed";
      now += 1001;
      await poller.refresh();
      expect(sample("lmu.rest.condition.aero").observation.state).toBe("invalid");
      mode = "delayed";
      now += 1001;
      const pending = poller.refresh();
      await requestStarted;
      poller.stop();
      mode = "ok";
      release?.();
      poller.activate({ sessionKey: "second", vehicleId: 84 });
      await poller.refresh();
      await pending;
      expect(poller.snapshot().every((entry) => entry.sessionKey === "second" && (entry.vehicleId === null || entry.vehicleId === 84))).toBe(true);
    } finally { poller.stop(); release?.(); await server.stop(true); }
  });

  test("retains precise changing contexts through production sparse framing and rejects malformed capture metadata", async () => {
    const memory = playerMemory();
    const context: LmuLiveContext = { schemaVersion: 1, key: { sessionKey: "capture", captureSequence: "9007199254740993", frameTime: { domain: "monotonic", nanoseconds: 9007199254740993123n } }, playerVehicleId: 42, status: "active", supplemental: [] };
    const first = encodeLMUSourceFrame(memory, 1000, { context })!;
    memory.writeFloatLE(0, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.virtualEnergy);
    const second = encodeLMUSourceFrame(memory, 1010, { context: { ...context, key: { ...context.key, captureSequence: "9007199254740994" } } })!;
    const encoder = new SparseCaptureEncoder("lmu");
    const prefix = encodeFrameLength(first.length);
    const firstPayload = encoder.encode(first, 0);
    const delta = encoder.encode(second, prefix.length + firstPayload.length);
    expect(delta.length).toBeLessThan(LMU_SOURCE_FRAME_V2_SIZE / 10);
    const bytes = Buffer.concat([prefix, firstPayload, encodeFrameLength(delta.length), delta]);
    const sync = [...iterateSessionCaptureRecords(bytes, 0, { strict: true })].filter((entry) => entry.kind === "frame");
    expect(sync.map((entry) => entry.frame)).toEqual([first, second]);
    async function* chunks() { for (let offset = 0; offset < bytes.length; offset += 777) yield bytes.subarray(offset, offset + 777); }
    const asyncRecords = await Array.fromAsync(iterateSessionCaptureRecordsAsync(chunks(), { strict: true }));
    expect(asyncRecords.filter((entry) => entry.kind === "frame").map((entry) => entry.frame)).toEqual([first, second]);
    expect(decodeLMUSourceFrame(second)!.lmuContext!.key.frameTime).toEqual(context.key.frameTime);
    expect(decodeLmuContext(JSON.parse(JSON.stringify(encodeLmuContext(context))))).toEqual(context);
    const corrupt = Buffer.from(first);
    corrupt.writeUInt8(255, 28 + LMU_TELEMETRY_HEADER_OFFSET + 1);
    expect(decodeLMUSourceFrame(corrupt)).toBeNull();
    expect(decodeLmuContext({ ...encodeLmuContext(context), competitors: [] })).toBeNull();
  });
});
