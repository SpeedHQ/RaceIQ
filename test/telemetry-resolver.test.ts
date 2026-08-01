import { describe, expect, test } from "bun:test";
import {
  getTelemetryVariable,
  TELEMETRY_CATALOG,
} from "../shared/telemetry-catalog";
import {
  compileTelemetryResolver,
  TELEMETRY_DERIVATION_VERSION,
  TELEMETRY_PARSER_VERSIONS,
  TELEMETRY_RESOLVER_VERSION,
  type ResolvedValue,
} from "../shared/telemetry-resolver";
import { KNOWN_GAME_IDS, type GameId, type TelemetryPacket } from "../shared/types";

function packet(gameId: GameId, values: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId,
    TimestampMS: 1_000,
    Speed: 42,
    IsRaceOn: 1,
    Fuel: 0.5,
    FuelCapacity: 0,
    ...values,
  } as TelemetryPacket;
}

describe("compiled telemetry resolver", () => {
  test("compiles normalized packet fields for every supported simulator", () => {
    for (const gameId of KNOWN_GAME_IDS) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator: gameId,
        requested: [{ semanticId: "motion.speed", required: true }],
      });
      const speed = resolver.slot("motion.speed");
      const frame = resolver.createFrameView(packet(gameId), 1_000);

      expect(frame.readNumber(speed)).toBe(42);
      expect(frame.resolveNumber(speed)).toMatchObject({
        semanticId: "motion.speed",
        value: 42,
        mappingStatus: getTelemetryVariable("motion.speed").games[gameId].kind,
        state: "ok",
        provenance: {
          simulator: gameId,
          parserVersion: TELEMETRY_PARSER_VERSIONS[gameId],
          resolverVersion: TELEMETRY_RESOLVER_VERSION,
        },
      });
      expect(resolver.derivationVersion).toBe(TELEMETRY_DERIVATION_VERSION);
    }
  });

  test("resolves simplified per-wheel values without losing fidelity status", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "tire.temperature.carcass.average" }],
    });
    const slot = resolver.slot("tire.temperature.carcass.average");
    const frame = resolver.createFrameView(
      packet("iracing", {
        TireCarcassTempFL: 80,
        TireCarcassTempFR: 81,
        TireCarcassTempRL: 82,
        TireCarcassTempRR: 83,
      }),
      1_000,
    );

    expect(frame.resolveValue<readonly number[]>(slot)).toMatchObject({
      value: [80, 81, 82, 83],
      mappingStatus: "simplified",
      state: "ok",
    });
  });

  test("reuses one frame view without retaining per-frame values", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
    });
    const speed = resolver.slot("motion.speed");
    const first = resolver.createFrameView(packet("acc", { Speed: 10 }), 1_000);
    expect(first.readNumber(speed)).toBe(10);

    const second = resolver.createFrameView(
      packet("acc", { Speed: 20, TimestampMS: 2_000 }),
      2_000,
      first,
    );
    expect(second).toBe(first);
    expect(second.readNumber(speed)).toBe(20);
  });

  test("separates stale runtime state from mapping fidelity", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
      staleAfterMs: { "motion.speed": 50 },
    });
    const speed = resolver.slot("motion.speed");
    const frame = resolver.createFrameView(
      packet("acc", { TimestampMS: 1_000 }),
      1_100,
    );

    expect(frame.readNumber(speed)).toBeUndefined();
    expect(frame.resolveNumber(speed)).toMatchObject({
      value: 42,
      mappingStatus: getTelemetryVariable("motion.speed").games.acc.kind,
      state: "stale",
      confidenceComponents: { freshness: 0 },
    });
  });

  test("exposes unavailable mappings through stable slots", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "weather.wind-speed" }],
    });
    const slot = resolver.slot("weather.wind-speed");
    const frame = resolver.createFrameView(packet("f1-2025"), 1_000);

    expect(frame.readNumber(slot)).toBeUndefined();
    expect(frame.resolveNumber(slot)).toMatchObject({
      value: null,
      mappingStatus: "unavailable",
      state: "missing",
    });
  });

  test("evaluates and memoizes deterministic derivations", () => {
    let evaluations = 0;
    const derivation = {
      id: "test.double-speed",
      version: "1",
      output: { semanticId: "fuel.fuel-percent", unit: "%", valueType: "number" as const },
      inputs: [{ semanticId: "motion.speed", acceptedMappings: ["direct" as const], required: true }],
      missingDataPolicy: "unavailable" as const,
      deterministic: true,
      codeHash: "sha256:test-double-speed",
      evaluate(context: { number(id: string): number | undefined; unavailable(): { state: "missing" }; value<T>(value: T): { state: "ok"; value: T } }) {
        evaluations += 1;
        const speed = context.number("motion.speed");
        return speed === undefined ? context.unavailable() : context.value(speed * 2);
      },
    };
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "fuel.fuel-percent" }],
      derivations: [derivation],
    });
    const slot = resolver.slot("fuel.fuel-percent");
    const frame = resolver.createFrameView(packet("acc", { Speed: 30 }), 1_000);

    expect(frame.readNumber(slot)).toBe(60);
    expect(frame.readNumber(slot)).toBe(60);
    expect(evaluations).toBe(1);
    expect(frame.resolveNumber(slot).provenance.derivation).toEqual({
      id: derivation.id,
      version: derivation.version,
      codeHash: derivation.codeHash,
    });
  });

  test("rejects cycles before creating a frame", () => {
    const a = {
      id: "cycle-a",
      version: "1",
      output: { semanticId: "motion.speed", unit: "m/s", valueType: "number" as const },
      inputs: [{ semanticId: "fuel.fuel-percent", acceptedMappings: ["derived" as const], required: true }],
      missingDataPolicy: "unavailable" as const,
      deterministic: true,
      codeHash: "sha256:cycle-a",
      evaluate: () => ({ state: "missing" as const }),
    };
    const b = {
      id: "cycle-b",
      version: "1",
      output: { semanticId: "fuel.fuel-percent", unit: "%", valueType: "number" as const },
      inputs: [{ semanticId: "motion.speed", acceptedMappings: ["derived" as const], required: true }],
      missingDataPolicy: "unavailable" as const,
      deterministic: true,
      codeHash: "sha256:cycle-b",
      evaluate: () => ({ state: "missing" as const }),
    };

    expect(() =>
      compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator: "acc",
        requested: [{ semanticId: "fuel.fuel-percent" }],
        derivations: [a, b],
      }),
    ).toThrow("Telemetry derivation cycle");
  });

  test("reads per-wheel values in declared catalog order", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "tires.tire-slip-ratio" }],
    });
    const slot = resolver.slot("tires.tire-slip-ratio");
    const frame = resolver.createFrameView(
      packet("fm-2023", {
        TireSlipRatioFL: 0.1,
        TireSlipRatioFR: 0.2,
        TireSlipRatioRL: 0.3,
        TireSlipRatioRR: 0.4,
      }),
      1_000,
    );

    expect(frame.readValue<readonly number[]>(slot)).toEqual([
      0.1,
      0.2,
      0.3,
      0.4,
    ]);
    expect(frame.resolveValue<readonly number[]>(slot)).toMatchObject({
      value: [0.1, 0.2, 0.3, 0.4],
      state: "ok",
    });
  });

  test("aliases canonical wheel order to iRacing LF/RF/LR keys", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "brakes.brake-line-press" }],
    });
    const slot = resolver.slot("brakes.brake-line-press");
    const frame = resolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: {
          LFbrakeLinePress: 11,
          RFbrakeLinePress: 12,
          LRbrakeLinePress: 13,
          RRbrakeLinePress: 14,
        },
      },
      1_000,
    );

    expect(frame.readValue<readonly number[]>(slot)).toEqual([11, 12, 13, 14]);
  });

  test("falls back from absent packet fields to native sources", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "motion.speed" }],
    });
    const slot = resolver.slot("motion.speed");
    const frame = resolver.createFrameView(
      {
        packet: packet("fm-2023", {
          Speed: undefined as unknown as number,
        }),
        nativeValues: { Speed: 61 },
      },
      1_000,
    );

    expect(frame.readNumber(slot)).toBe(61);
  });

  test("assembles and reuses ordered native per-wheel storage", () => {
    type NativeFrame = {
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    };
    const resolver = compileTelemetryResolver<NativeFrame>(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "tires.tire-slip-ratio" }],
    });
    const slot = resolver.slot("tires.tire-slip-ratio");
    const nativeValues = {
      TireSlipRatioFL: 0.1,
      TireSlipRatioFR: 0.2,
      TireSlipRatioRL: 0.3,
      TireSlipRatioRR: 0.4,
    };
    const nativeFrame: NativeFrame = {
      packet: packet("fm-2023", {
        TireSlipRatioFL: undefined as unknown as number,
        TireSlipRatioFR: undefined as unknown as number,
        TireSlipRatioRL: undefined as unknown as number,
        TireSlipRatioRR: undefined as unknown as number,
      }),
      nativeValues,
    };
    const firstFrame = resolver.createFrameView(nativeFrame, 1_000);
    const first = firstFrame.readValue<number[]>(slot)!;
    expect(first).toEqual([0.1, 0.2, 0.3, 0.4]);

    nativeValues.TireSlipRatioFL = 1.1;
    nativeValues.TireSlipRatioFR = 1.2;
    nativeValues.TireSlipRatioRL = 1.3;
    nativeValues.TireSlipRatioRR = 1.4;
    const secondFrame = resolver.createFrameView(
      nativeFrame,
      1_000,
      firstFrame,
    );
    const second = secondFrame.readValue<number[]>(slot)!;
    expect(second).toBe(first);
    expect(second).toEqual([1.1, 1.2, 1.3, 1.4]);
  });

  test("derives canonical F1 lap fraction instead of returning metres", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "timing.lap-fraction" }],
    });
    const slot = resolver.slot("timing.lap-fraction");
    const frame = resolver.createFrameView(
      packet("f1-2025", {
        DistanceTraveled: 2_500,
        f1: { trackLength: 5_000 } as TelemetryPacket["f1"],
      }),
      1_000,
    );

    expect(frame.readNumber(slot)).toBe(0.5);
    expect(frame.resolveNumber(slot)).toMatchObject({
      value: 0.5,
      state: "ok",
      provenance: {
        derivation: { id: "raceiq.timing.lap-fraction" },
      },
    });
  });

  test("derives AC Evo lap fraction with kilometre track length conversion", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "ac-evo",
      requested: [{ semanticId: "timing.lap-fraction" }],
    });
    const slot = resolver.slot("timing.lap-fraction");
    const frame = resolver.createFrameView(
      {
        packet: packet("ac-evo", { DistanceTraveled: 7_500 }),
        nativeValues: { "acEvo.lapLengthKm": 5 },
      },
      1_000,
    );

    expect(frame.readNumber(slot)).toBe(0.5);
  });

  test("derives iRacing lap fraction with canonical metre track length", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "timing.lap-fraction" }],
    });
    const slot = resolver.slot("timing.lap-fraction");
    const frame = resolver.createFrameView(
      {
        packet: packet("iracing", { DistanceTraveled: 7_500 }),
        nativeValues: { trackLengthM: 5_000 },
      },
      1_000,
    );

    expect(frame.readNumber(slot)).toBe(0.5);
  });

  test("returns typed error for an unregistered mapping executor", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "timing.sector.current-lap.times" }],
    });
    const slot = resolver.slot("timing.sector.current-lap.times");
    const frame = resolver.createFrameView(packet("f1-2025"), 1_000);

    expect(frame.readValue<readonly number[]>(slot)).toBeUndefined();
    expect(frame.resolveValue<readonly number[]>(slot)).toMatchObject({
      value: null,
      mappingStatus: "derived",
      state: "error",
    });
  });

  test("propagates stale dependency state through derivations", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "timing.lap-fraction" }],
      staleAfterMs: { "timing.distance-traveled": 50 },
    });
    const slot = resolver.slot("timing.lap-fraction");
    const frame = resolver.createFrameView(
      packet("f1-2025", {
        TimestampMS: 1_000,
        DistanceTraveled: 2_500,
        f1: { trackLength: 5_000 } as TelemetryPacket["f1"],
      }),
      1_100,
    );

    expect(frame.readNumber(slot)).toBeUndefined();
    expect(frame.resolveNumber(slot)).toMatchObject({
      value: null,
      state: "stale",
    });
  });

  test("validates structured native indices, cardinality, and field types", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "race.competitor.position" }],
    });
    const slot = resolver.slot("race.competitor.position");
    const positions = [2, 1];
    const validFrame = resolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: { CarIdxPosition: positions },
      },
      1_000,
    );

    expect(validFrame.readValue<typeof positions>(slot)).toBe(positions);
    expect(validFrame.resolveValue<typeof positions>(slot)).toMatchObject({
      value: positions,
      state: "ok",
    });

    const wrongTypeFrame = resolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: { CarIdxPosition: [2, "first"] },
      },
      1_000,
      validFrame,
    );
    expect(wrongTypeFrame.resolveValue(slot).state).toBe("invalid");

    const tooManyFrame = resolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: { CarIdxPosition: new Array(65).fill(1) },
      },
      1_000,
      validFrame,
    );
    expect(tooManyFrame.resolveValue(slot).state).toBe("invalid");
  });

  test("canonicalizes and enforces enum domains", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "tires.tire-compound" }],
    });
    const slot = resolver.slot("tires.tire-compound");
    const valid = resolver.createFrameView(
      packet("f1-2025", { TyreCompound: 7 as unknown as string }),
      1_000,
    );
    expect(valid.readValue<string>(slot)).toBe("7");

    const invalid = resolver.createFrameView(
      packet("f1-2025", { TyreCompound: 999 as unknown as string }),
      1_000,
      valid,
    );
    expect(invalid.resolveValue(slot).state).toBe("invalid");
  });

  test("rejects invalid collection shape and scalar type", () => {
    const wheelResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "tires.tire-slip-ratio" }],
    });
    const wheelSlot = wheelResolver.slot("tires.tire-slip-ratio");
    const wheelFrame = wheelResolver.createFrameView(
      packet("fm-2023", {
        TireSlipRatioFL: 0.1,
        TireSlipRatioFR: 0.2,
        TireSlipRatioRL: 0.3,
        TireSlipRatioRR: undefined as unknown as number,
      }),
      1_000,
    );
    expect(wheelFrame.readValue<readonly number[]>(wheelSlot)).toBeUndefined();
    expect(wheelFrame.resolveValue<readonly number[]>(wheelSlot).state).toBe(
      "invalid",
    );

    const scalarResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
    });
    const scalarSlot = scalarResolver.slot("motion.speed");
    const scalarFrame = scalarResolver.createFrameView(
      packet("acc", { Speed: "fast" as unknown as number }),
      1_000,
    );
    expect(scalarFrame.readValue<number>(scalarSlot)).toBeUndefined();
    expect(scalarFrame.resolveValue<number>(scalarSlot).state).toBe("invalid");
  });

  test("resolveMany reuses caller-owned output storage", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }, { semanticId: "race.is-race-on" }],
    });
    const slots = [resolver.slot("motion.speed"), resolver.slot("race.is-race-on")];
    const target: ResolvedValue<unknown>[] = [];
    const result = resolver.createFrameView(packet("acc"), 1_000).resolveMany(slots, target);

    expect(result).toBe(target);
    expect(result.map((value) => value.semanticId)).toEqual(["motion.speed", "race.is-race-on"]);
  });
});
