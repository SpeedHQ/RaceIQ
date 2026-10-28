import { describe, expect, test, spyOn } from "bun:test";
import { LmuOpponentIdentityTracker } from "@raceiq/capture-formats/lmu/opponent-snapshot";
import { lmuSnapshotsCoherent } from "@raceiq/game-lmu/test-support/memory-reader";
import { createServer } from "node:http";
import { once } from "node:events";
import { isLmuRestValue } from "@raceiq/shared/telemetry/lmu-rest-channels";
import { LMUTelemetrySource } from "@raceiq/game-lmu/source";
import { LmuSupplementalRest } from "@raceiq/game-lmu/test-support/supplemental-rest";
import { normalizeLMUSourceFrame } from "@raceiq/game-lmu/normalizer";
import { encodeLMUSourceFrame, decodeLMUSourceFrame, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY_INFO_SIZE, LMU_TELEMETRY, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE, LMU_SCORING_VEHICLE_SIZE } from "@raceiq/capture-formats/lmu/layout";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import { isLiveTelemetryFrameMessageV1 } from "@raceiq/shared/telemetry/live/contracts";
import { encodeLmuContext, decodeLmuContext, isLmuLiveContextWire } from "@raceiq/shared/telemetry/lmu-context";
import type { LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { encodeFrameLength, iterateSessionCaptureRecords, iterateSessionCaptureRecordsAsync } from "@raceiq/capture-formats/session/framing";
import { playerMemory } from "../../support/player-memory";


describe("LMU Phase 1 player pipeline", () => {
  test("projects independent native energy and double-precision player channels with honest invalid and zero states", () => {
    const memory = playerMemory();
    const frame = decodeLMUSourceFrame(encodeLMUSourceFrame(memory, 1000)!)!;
    const packet = normalizeLMUSourceFrame(frame)!;
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
    const invalid = projector.project({ packet: normalizeLMUSourceFrame(decodeLMUSourceFrame(encodeLMUSourceFrame(memory, 1010)!)!)!, receivedAtMs: 1010 }).frame!;
    const energy = schema.definitions.findIndex((entry) => entry.semanticId === "fuel.virtual-energy");
    expect(invalid.values[energy]).toBeNull();
    expect(invalid.states?.[energy]).toBe("invalid");
    expect(invalid.values[schema.definitions.findIndex((entry) => entry.semanticId === "fuel.battery-charge-fraction")]).toBe(0);
  });

  test("native lap fraction resolves boundaries and rejects invalid distance without inventing zero", () => {
    const memory = playerMemory();
    const projector = new LiveTelemetryProjector();
    let timestamp = 1000;
    let slot = -1;
    const project = (distance: number, length: number) => {
      memory.writeDoubleLE(distance, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.lapDistance);
      memory.writeDoubleLE(length, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.lapDistance);
      const packet = normalizeLMUSourceFrame(decodeLMUSourceFrame(encodeLMUSourceFrame(memory, timestamp++)!)!);
      if (!packet) throw new Error("Expected a player packet from the native LMU fixture");
      const result = projector.project({ packet, receivedAtMs: timestamp });
      if (result.schema) slot = result.schema.definitions.findIndex((definition) => definition.semanticId === "timing.lap-fraction");
      return { value: result.frame!.values[slot], state: result.frame!.states?.[slot] ?? "ok" };
    };
    expect(project(250, 1000)).toEqual({ value: 0.25, state: "ok" });
    expect(project(0, 1000)).toEqual({ value: 0, state: "ok" });
    expect(project(1000, 1000)).toEqual({ value: 1, state: "ok" });
    for (const [distance, length] of [[NaN, 1000], [-1, 1000], [1001, 1000], [250, 0], [250, NaN]]) {
      expect(project(distance!, length!).value).toBeNull();
    }
    expect(project(500, 1000)).toEqual({ value: 0.5, state: "ok" });
    memory.writeDoubleLE(20, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
    expect(project(500, 1000)).toEqual({ value: null, state: "stale" });
    memory.writeDoubleLE(20, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
    expect(project(500, 1000)).toEqual({ value: 0.5, state: "ok" });
  });

  test("invalidates no-player, duplicate identity, rewind and frozen snapshots without guessing a player", async () => {
    let wallNow = 100_000;
    let monotonicNow = 500;
    const wallClock = spyOn(Date, "now").mockImplementation(() => wallNow);
    const monotonicClock = spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const memory = playerMemory();
    let available = true;
    const contexts: LmuLiveContext[] = [];
    const frames: Buffer[] = [];
    const source = new LMUTelemetrySource({ rest: false, reader: { start() {}, async stop() {}, readLatest: () => available ? memory : null }, dispatchRawFrame: async (frame) => { frames.push(frame); }, publishUnavailable: (context) => { contexts.push(context); } });
    try {
      expect(await source.pollOnce()).toBe(true);
      const firstKey = decodeLMUSourceFrame(frames[0]!)!.lmuContext!.key.sessionKey;
      memory.writeDoubleLE(1, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
      expect(await source.pollOnce()).toBe(true);
      expect(decodeLMUSourceFrame(frames[1]!)!.lmuContext!.key.sessionKey).not.toBe(firstKey);
      wallNow -= 50_000;
      monotonicNow += 1001;
      expect(await source.pollOnce()).toBe(false);
      expect(contexts.at(-1)?.status).toBe("unavailable");
      memory.writeDoubleLE(2, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
      expect(await source.pollOnce()).toBe(true);
      available = false;
      wallNow -= 50_000;
      monotonicNow += 1001;
      expect(await source.pollOnce()).toBe(false);
      memory.writeUInt8(0, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
      expect(await source.pollOnce()).toBe(false);
      memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
      available = true;
      memory.copy(memory, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE_SIZE);
      memory.writeInt32LE(2, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
      expect(await source.pollOnce()).toBe(false);
      expect(frames).toHaveLength(3);
    } finally { await source.stop(); wallClock.mockRestore(); monotonicClock.mockRestore(); }
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
      for (let index = 0; index < 4; index++) {
        now += 1001;
        await poller.refresh();
        expect(sample("lmu.rest.condition.aero").observation).toMatchObject({ state: "ok", value: 0 });
        expect(sample("lmu.rest.condition.aero").acquiredAt).toEqual({ domain: "wall-clock", milliseconds: now });
        expect(sample("lmu.rest.condition.aero").observation.provenance).toEqual(original);
      }
      now += 3000;
      expect(sample("lmu.rest.condition.aero").observation).toMatchObject({ state: "ok", value: 0 });
      now++;
      expect(sample("lmu.rest.condition.aero").observation).toMatchObject({ state: "stale", value: null });
      await poller.refresh();
      expect(sample("lmu.rest.condition.aero").observation).toMatchObject({ state: "ok", value: 0 });
      expect(sample("lmu.rest.condition.aero").observation.provenance).toEqual(original);
      const lastSuccessfulAcquisition = sample("lmu.rest.condition.aero").acquiredAt;
      mode = "error";
      now += 1001;
      await poller.refresh();
      expect(sample("lmu.rest.condition.aero").observation.state).toBe("error");
      expect(sample("lmu.rest.condition.aero").observation.provenance).toEqual(original);
      expect(sample("lmu.rest.condition.aero").acquiredAt).toEqual(lastSuccessfulAcquisition);
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
  test("validates condition values by semantic shape and preserves zero", () => {
    expect(isLmuRestValue("lmu.rest.condition.aero", 0)).toBe(true);
    expect(isLmuRestValue("lmu.rest.condition.aero", [0, 0, 0, 0])).toBe(false);
    expect(isLmuRestValue("lmu.rest.condition.brakes", [0, 0, 0, 0])).toBe(true);
    expect(isLmuRestValue("lmu.rest.condition.brakes", 0)).toBe(false);
    expect(isLmuRestValue("lmu.rest.condition.suspension", [0, 0, 0, 0])).toBe(true);
    expect(isLmuRestValue("lmu.rest.condition.suspension", [0, 0, 0])).toBe(false);
  });

  test("cancels response bodies rejected by status and declared size", async () => {
    const closed = new Set<string>();
    let allClosed!: () => void;
    const cancelled = new Promise<void>((resolve) => { allClosed = resolve; });
    // Bun.serve rewrites streamed Content-Length to chunked; Node preserves the rejected header.
    const server = createServer((req, res) => {
      const label = req.url?.endsWith("RepairAndRefuel") ? "status" : "length";
      req.socket.once("close", () => {
        closed.add(label);
        if (closed.has("status") && closed.has("length")) allClosed();
      });
      res.writeHead(label === "status" ? 503 : 200, label === "length" ? { "content-length": String(1024 * 1024 + 1) } : {});
      res.flushHeaders();
      res.write("{");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback server address");
    const poller = new LmuSupplementalRest({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      poller.activate({ sessionKey: "cancel", vehicleId: 42 });
      await poller.refresh();
      await Promise.race([cancelled, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Rejected response bodies remained open")), 500);
      })]);
      expect(closed.has("status")).toBe(true);
      expect(closed.has("length")).toBe(true);
    } finally {
      clearTimeout(deadline);
      poller.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  test("publishes malformed condition HTTP values as invalid and rejects malformed ok wire values", async () => {
    let malformed = true;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      if (new URL(req.url).pathname.includes("RepairAndRefuel")) {
        return Response.json({ wearables: { body: { aero: malformed ? [0, 0, 0, 0] : 0 }, brakes: malformed ? 0 : [0, 0, 0, 0], suspension: [0, 0, 0, 0] } });
      }
      if (new URL(req.url).pathname === "/rest/sessions") return Response.json({ SESSSET_race_timescale: { currentValue: 2 }, SESSSET_private_qual: { currentValue: 0 } });
      return Response.json({});
    } });
    const poller = new LmuSupplementalRest({ baseUrl: `http://127.0.0.1:${server.port}` });
    const sample = (id: string) => poller.snapshot().find((entry) => entry.semanticId === id)!;
    try {
      poller.activate({ sessionKey: "shape", vehicleId: 42 });
      await poller.refresh();
      expect(sample("lmu.rest.condition.aero").observation).toMatchObject({ value: null, state: "invalid" });
      expect(sample("lmu.rest.condition.brakes").observation).toMatchObject({ value: null, state: "invalid" });
      const wire = encodeLmuContext({ schemaVersion: 1, key: { sessionKey: "shape", captureSequence: "1", frameTime: { domain: "wall-clock", milliseconds: Date.now() } }, playerVehicleId: 42, status: "active", supplemental: poller.snapshot() });
      for (const [id, value] of [["lmu.rest.condition.aero", [0, 0, 0, 0]], ["lmu.rest.condition.brakes", 0]] as const) {
        const bad = structuredClone(wire);
        const entry = bad.supplemental.find((item) => item.semanticId === id)!;
        Object.assign(entry.observation, { value, state: "ok" });
        expect(decodeLmuContext(bad)).toBeNull();
      }
      malformed = false;
      poller.stop();
      poller.activate({ sessionKey: "shape-valid-zero", vehicleId: 42 });
      await poller.refresh();
      expect(sample("lmu.rest.condition.aero").observation).toMatchObject({ value: 0, state: "ok" });
      expect(sample("lmu.rest.condition.brakes").observation).toMatchObject({ value: [0, 0, 0, 0], state: "ok" });
    } finally { poller.stop(); await server.stop(true); }
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
    const competitorContext: LmuLiveContext = {
      ...context,
      competitors: [{
        vehicleId: 42,
        incarnation: 0,
        isPlayer: true,
        channels: {
          "timing.competitor.total-time": {
            semanticId: "timing.competitor.total-time",
            value: 0,
            unit: "s",
            mappingStatus: "direct",
            state: "ok",
            confidence: 1,
            freshness: "fresh",
            confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 },
            provenance: {
              simulator: "lmu",
              parserId: "lmu-scoring",
              parserVersion: "1",
              resolverVersion: "1",
              catalogVersion: "1",
              catalogHash: "test",
              observedAt: { domain: "monotonic", nanoseconds: 9007199254740993123n },
              sourceObservation: { timestamp: { domain: "monotonic", nanoseconds: 9007199254740993123n }, updateSequence: 9007199254740993123n },
            },
            schemaVersion: "1",
            limitations: [],
          },
        },
      }],
    };
    const competitorWire = JSON.parse(JSON.stringify(encodeLmuContext(competitorContext)));
    expect(decodeLmuContext(competitorWire)).toEqual(competitorContext);
    const scoringOnlyContext = { ...context, playerVehicleId: null, competitors: [] as const };
    expect(isLmuLiveContextWire(encodeLmuContext(scoringOnlyContext))).toBe(true);
    expect(isLmuLiveContextWire(competitorWire)).toBe(true);
    const impreciseWire = structuredClone(competitorWire);
    impreciseWire.competitors[0].channels["timing.competitor.total-time"].provenance.sourceObservation.updateSequence = "1".repeat(41);
    expect(isLmuLiveContextWire(impreciseWire)).toBe(false);
    competitorWire.competitors[0].channels["timing.competitor.total-time"].provenance.sourceObservation.updateSequence = "9007199254740993124";
    expect(decodeLmuContext(competitorWire)!.competitors?.[0]?.channels["timing.competitor.total-time"]?.provenance.sourceObservation?.updateSequence).toBe(9007199254740993124n);
    const corrupt = Buffer.from(first);
    corrupt.writeUInt8(255, 28 + LMU_TELEMETRY_HEADER_OFFSET + 1);
    expect(decodeLMUSourceFrame(corrupt)).toBeNull();
    expect(decodeLmuContext({ ...encodeLmuContext(context), competitors: [] })).toBeNull();
  });
});

describe("LMU scoring competitor snapshots", () => {
  test("keeps mID identity through reorder, increments reuse incarnations, rejects duplicates and supports no-player grids", () => {
    const memory = playerMemory();
    const tracker = new LmuOpponentIdentityTracker();
    const first = tracker.snapshot(memory, "session-generation", 1n, 42)!;
    expect(first.map((entry) => [entry.vehicleId, entry.incarnation, entry.isPlayer])).toEqual([[42, 0, true]]);
    expect(first[0]!.channels["motion.competitor.position.x"]!.unit).toBe("m");
    expect(first[0]!.channels["motion.competitor.local-velocity.x"]!.unit).toBe("m/s");
    expect(first[0]!.channels["race.competitor.estimated-lap-time"]!.semanticId).toBe("race.competitor.estimated-lap-time");
    const firstId = LMU_SCORING_VEHICLES_OFFSET;
    const secondId = firstId + LMU_SCORING_VEHICLE_SIZE;
    memory.writeInt32LE(7, secondId + LMU_SCORING_VEHICLE.id);
    memory.write("Opponent", secondId + LMU_SCORING_VEHICLE.driverName);
    memory.write("Car B", secondId + LMU_SCORING_VEHICLE.vehicleName);
    memory.write("GT3", secondId + LMU_SCORING_VEHICLE.vehicleClass);
    memory.writeInt16LE(0, secondId + LMU_SCORING_VEHICLE.totalLaps);
    memory.writeUInt8(0, secondId + LMU_SCORING_VEHICLE.isPlayer);
    memory.writeInt32LE(2, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
    const expanded = tracker.snapshot(memory, "session-generation", 2n, 42)!;
    expect(expanded.map((entry) => entry.vehicleId)).toEqual([42, 7]);
    const firstRow = Buffer.from(memory.subarray(firstId, firstId + LMU_SCORING_VEHICLE_SIZE));
    const secondRow = Buffer.from(memory.subarray(secondId, secondId + LMU_SCORING_VEHICLE_SIZE));
    secondRow.copy(memory, firstId);
    firstRow.copy(memory, secondId);
    const reordered = tracker.snapshot(memory, "session-generation", 3n, 42)!;
    expect(reordered.map((entry) => [entry.vehicleId, entry.incarnation])).toEqual([[7, 0], [42, 0]]);
    memory.copy(memory, firstId, secondId, secondId + LMU_SCORING_VEHICLE_SIZE);
    expect(tracker.snapshot(memory, "session-generation", 4n, 42)).toBeNull();
    secondRow.copy(memory, firstId);
    firstRow.copy(memory, secondId);
    memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
    memory.writeUInt8(1, firstId + LMU_SCORING_VEHICLE.isPlayer);
    expect(tracker.snapshot(memory, "session-generation", 5n, 7)!.map((entry) => entry.vehicleId)).toEqual([7]);
    firstRow.copy(memory, secondId);
    memory.writeUInt8(0, secondId + LMU_SCORING_VEHICLE.isPlayer);
    memory.writeInt32LE(2, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
    const rejoined = tracker.snapshot(memory, "session-generation", 6n, 7)!;
    expect(rejoined.find((entry) => entry.vehicleId === 42)?.incarnation).toBe(1);
    memory.write("Rejoined", secondId + LMU_SCORING_VEHICLE.driverName);
    expect(tracker.snapshot(memory, "session-generation", 7n, 7)!.find((entry) => entry.vehicleId === 42)?.incarnation).toBe(2);
    memory.writeUInt8(0, firstId + LMU_SCORING_VEHICLE.isPlayer);
    const noPlayer = tracker.snapshot(memory, "session-generation", 8n, null)!;
    expect(noPlayer.every((entry) => !entry.isPlayer)).toBe(true);
  });

  test("retains scoring source sequence at repeated clock and advances it on scoring time updates", () => {
    const memory = playerMemory();
    const tracker = new LmuOpponentIdentityTracker();
    const observationSequence = (captureSequence: bigint) => tracker.snapshot(memory, "session-generation", captureSequence, 42)![0]!.channels["race.competitor.scoring-time"]!.provenance.sourceObservation!.updateSequence;
    const first = observationSequence(1n);
    expect(observationSequence(2n)).toBe(first);
    memory.writeDoubleLE(10.5, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
    expect(observationSequence(3n)).toBe(first + 1n);
  });
  test("publishes scoring-only contexts without dispatching fabricated player frames", async () => {
    const memory = playerMemory();
    memory.writeUInt8(0, LMU_TELEMETRY_HEADER_OFFSET + 2);
    const contexts: LmuLiveContext[] = [];
    const frames: Buffer[] = [];
    const source = new LMUTelemetrySource({
      rest: false,
      reader: { start() {}, async stop() {}, readLatest: () => memory },
      dispatchRawFrame: async (frame) => { frames.push(frame); },
      publishScoringContext: (context) => { contexts.push(context); },
    });
    try {
      expect(await source.pollOnce()).toBe(true);
      expect(contexts.at(-1)).toMatchObject({ status: "active", playerVehicleId: 42, competitors: [{ vehicleId: 42, isPlayer: true }] });
      expect(await source.pollOnce()).toBe(false);
      memory.writeDoubleLE(11, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
      expect(await source.pollOnce()).toBe(true);
      expect(contexts.at(-1)?.key.captureSequence).toBe("2");
      expect(frames).toHaveLength(0);
    } finally { await source.stop(); }
  });
});

test("LMU coherence covers scoring and active player telemetry, while scoring-only snapshots need no guessed slot", () => {
  const first = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
  const second = Buffer.from(first);
  first.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  second.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  expect(lmuSnapshotsCoherent(first, second)).toBe(true);
  second.writeDoubleLE(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.lapDistance);
  expect(lmuSnapshotsCoherent(first, second)).toBe(false);
  first.copy(second);
  second.writeDoubleLE(2, LMU_TELEMETRY_INFO_OFFSET);
  expect(lmuSnapshotsCoherent(first, second)).toBe(true);
  first.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
  first.writeUInt8(0, LMU_TELEMETRY_HEADER_OFFSET + 1);
  first.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
  first.copy(second);
  second.writeDoubleLE(3, LMU_TELEMETRY_INFO_OFFSET);
  expect(lmuSnapshotsCoherent(first, second)).toBe(false);
  first.writeUInt8(2, LMU_TELEMETRY_HEADER_OFFSET);
  first.copy(second);
  second.writeInt32LE(7, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY_INFO_SIZE + LMU_TELEMETRY.id);
  expect(lmuSnapshotsCoherent(first, second)).toBe(false);
});

test("retains distinct scoring time/lap gaps and remote pit limitations, including zero and invalid reports", () => {
  const memory = playerMemory();
  const offset = LMU_SCORING_VEHICLES_OFFSET;
  memory.writeDoubleLE(2.5, offset + LMU_SCORING_VEHICLE.timeBehindNext);
  memory.writeInt32LE(1, offset + LMU_SCORING_VEHICLE.lapsBehindNext);
  memory.writeDoubleLE(17.25, offset + LMU_SCORING_VEHICLE.timeBehindLeader);
  memory.writeInt32LE(2, offset + LMU_SCORING_VEHICLE.lapsBehindLeader);
  memory.writeUInt8(1, offset + LMU_SCORING_VEHICLE.inPits);
  memory.writeUInt8(3, offset + LMU_SCORING_VEHICLE.pitState);
  const tracker = new LmuOpponentIdentityTracker();
  const channels = tracker.snapshot(memory, "scoring-reports", 1n, 42)![0]!.channels;
  expect(channels["race.competitor.time-behind-next"]).toMatchObject({ value: 2.5, unit: "s", state: "ok" });
  expect(channels["race.competitor.laps-behind-next"]).toMatchObject({ value: 1, unit: "count", state: "ok" });
  expect(channels["race.competitor.time-behind-leader"]).toMatchObject({ value: 17.25, unit: "s", state: "ok" });
  expect(channels["race.competitor.laps-behind-leader"]).toMatchObject({ value: 2, unit: "count", state: "ok" });
  expect(channels["race.competitor.in-pits"]).toMatchObject({ value: true, unit: "boolean", state: "ok" });
  expect(channels["race.competitor.in-pits"]!.limitations.join(" ")).toContain("not always accurate for remote vehicles");
  expect(channels["race.competitor.pit-state"]).toMatchObject({ value: 3, state: "ok" });
  expect(channels["race.competitor.server-scored"]).toMatchObject({ value: false, state: "ok" });
  memory.writeDoubleLE(0, offset + LMU_SCORING_VEHICLE.timeBehindNext);
  memory.writeInt32LE(0, offset + LMU_SCORING_VEHICLE.lapsBehindNext);
  memory.writeDoubleLE(-1, offset + LMU_SCORING_VEHICLE.timeBehindLeader);
  memory.writeInt32LE(-1, offset + LMU_SCORING_VEHICLE.lapsBehindLeader);
  memory.writeUInt8(255, offset + LMU_SCORING_VEHICLE.pitState);
  const invalid = tracker.snapshot(memory, "scoring-reports", 2n, 42)![0]!.channels;
  expect(invalid["race.competitor.time-behind-next"]).toMatchObject({ value: 0, state: "ok" });
  expect(invalid["race.competitor.laps-behind-next"]).toMatchObject({ value: 0, state: "ok" });
  expect(invalid["race.competitor.time-behind-leader"]).toMatchObject({ value: null, state: "invalid" });
  expect(invalid["race.competitor.laps-behind-leader"]).toMatchObject({ value: null, state: "invalid" });
  expect(invalid["race.competitor.pit-state"]).toMatchObject({ value: null, state: "invalid" });
});
