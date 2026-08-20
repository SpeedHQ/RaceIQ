import { describe, expect, test } from "bun:test";
import { KNOWN_GAME_IDS } from "../../../shared/games/ids";
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
import { getTelemetryVariable } from "../../../shared/telemetry/catalog/query";
import { TELEMETRY_DERIVATION_VERSION } from "../../../shared/telemetry/derivations/builtins";
import { compileTelemetryResolver } from "../../../shared/telemetry/resolver/compile";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "../../../shared/telemetry/resolver/versions";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { packet } from "../../support/telemetry/resolver";

describe("compiled telemetry resolver", () => {
  test("compiles normalized packet fields for every supported simulator", () => {
    for (const gameId of KNOWN_GAME_IDS) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator: gameId,
        requested: [{ semanticId: "motion.speed", required: true }],
      });
      const speed = resolver.slot("motion.speed");
      const frame = resolver.createFrameView(packet(gameId), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });

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

  test("uses normalized iRacing packet positions instead of raw GPS latitude and longitude", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "motion.position-x" }, { semanticId: "motion.position-z" }],
    });
    const frame = resolver.createFrameView(
      packet("iracing", {
        PositionX: 123,
        PositionZ: -456,
        iracing: { latitudeDeg: 29.18, longitudeDeg: -81.07, altitudeM: 10 } as TelemetryPacket["iracing"],
      }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );

    expect(frame.readNumber(resolver.slot("motion.position-x"))).toBe(123);
    expect(frame.readNumber(resolver.slot("motion.position-z"))).toBe(-456);
  });

  test("uses canonical packet values without running a derivation DAG", () => {
    let evaluations = 0;
    const derivation = {
      id: "test.override-normalized-speed",
      version: "1",
      output: {
        semanticId: "motion.speed",
        unit: "m/s",
        valueType: "number" as const,
      },
      inputs: [],
      missingDataPolicy: "unavailable" as const,
      deterministic: true,
      codeHash: "sha256:test-override-normalized-speed",
      evaluate: () => {
        evaluations += 1;
        return { state: "ok" as const, value: 999 };
      },
    };
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
      derivations: [derivation],
    });
    const resolved = resolver
      .createFrameView(packet("acc", { Speed: 42 }), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) })
      .resolveNumber(resolver.slot("motion.speed"));

    expect(resolved).toMatchObject({
      value: 42,
      mappingStatus: "direct",
      confidence: 1,
      confidenceComponents: {
        semanticFidelity: 1,
        freshness: 1,
        inputCompleteness: 1,
      },
    });
    expect(resolved.provenance.derivation).toBeUndefined();
    expect(evaluations).toBe(0);
  });

  test("converts packet driver inputs to canonical ratios", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [
        { semanticId: "inputs.throttle" },
        { semanticId: "inputs.brake" },
        { semanticId: "inputs.clutch" },
        { semanticId: "inputs.handbrake" },
        { semanticId: "inputs.steering" },
      ],
    });
    const frame = resolver.createFrameView(
      packet("fm-2023", {
        Accel: 128,
        Brake: 128,
        Clutch: 128,
        HandBrake: 128,
        Steer: -64,
      }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );

    for (const semanticId of ["inputs.throttle", "inputs.brake", "inputs.clutch", "inputs.handbrake"] as const) {
      expect(frame.readNumber(resolver.slot(semanticId))).toBe(128 / 255);
    }
    expect(frame.readNumber(resolver.slot("inputs.steering"))).toBe(-0.5);
  });

  test("prefers live shift-light RPM and falls back to SessionInfo", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "engine.shift-light.first-rpm" }],
    });
    const slot = resolver.slot("engine.shift-light.first-rpm");
    const fallback = resolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: {
          "SessionInfo.DriverInfo.DriverCarSLFirstRPM": 6_500,
        },
      },
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(fallback.readNumber(slot)).toBe(6_500);

    const live = resolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: {
          PlayerCarSLFirstRPM: 7_000,
          "SessionInfo.DriverInfo.DriverCarSLFirstRPM": 6_500,
        },
      },
      { timestamp: { domain: "session", milliseconds: 2_000 }, updateSequence: 2n },
    );
    expect(live.readNumber(slot)).toBe(7_000);
  });

  test("normalizes session time remaining to seconds", () => {
    const acEvoResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "ac-evo",
      requested: [{ semanticId: "timing.session-time-remaining" }],
    });
    const acEvoFrame = acEvoResolver.createFrameView(
      packet("ac-evo", {
        acc: {
          acEvo: { sessionTimeLeftMs: 90_000 },
        } as TelemetryPacket["acc"],
      }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(
      acEvoFrame.readNumber(
        acEvoResolver.slot("timing.session-time-remaining"),
      ),
    ).toBe(90);

    const iracingResolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "timing.session-time-remaining" }],
    });
    const iracingFrame = iracingResolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: { SessionTimeRemain: 90 },
      },
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(
      iracingFrame.readNumber(
        iracingResolver.slot("timing.session-time-remaining"),
      ),
    ).toBe(90);
  });

  test("executes explicit source conversions without formula evaluation", () => {
    const acEvoResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "ac-evo",
      requested: [
        { semanticId: "timing.delta-to-reference" },
        { semanticId: "timing.time-of-day" },
      ],
    });
    const acEvoFrame = acEvoResolver.createFrameView(
      packet("ac-evo", {
        acc: {
          acEvo: {
            deltaTimeMs: 2_500,
            timeOfDayHours: 1,
            timeOfDayMinutes: 2,
            timeOfDaySeconds: 3,
          },
        } as TelemetryPacket["acc"],
      }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(
      acEvoFrame.readNumber(acEvoResolver.slot("timing.delta-to-reference")),
    ).toBe(2.5);
    expect(
      acEvoFrame.readNumber(acEvoResolver.slot("timing.time-of-day")),
    ).toBe(3_723);

    const f1Resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [
        { semanticId: "engine.fuel-mixture" },
        { semanticId: "timing.pit-lane-time-in-lane" },
      ],
    });
    const f1Frame = f1Resolver.createFrameView(
      packet("f1-2025", {
        f1: {
          fuelMix: 2,
          pitLaneTimeInLaneInMS: 90_000,
        } as TelemetryPacket["f1"],
      }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(
      f1Frame.readValue<string>(f1Resolver.slot("engine.fuel-mixture")),
    ).toBe("rich");
    expect(
      f1Frame.readNumber(
        f1Resolver.slot("timing.pit-lane-time-in-lane"),
      ),
    ).toBe(90);

    const timestampResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "session.timestamp" }],
    });
    const timestampFrame = timestampResolver.createFrameView(
      packet("fm-2023", { TimestampMS: 1_234 }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(
      timestampFrame.readNumber(timestampResolver.slot("session.timestamp")),
    ).toBe(1.234);
  });

  test("resolves parser-normalized F1 competitor pit arrays directly", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [
        { semanticId: "race.competitor.pit-status" },
        { semanticId: "race.competitor.on-pit-road" },
      ],
    });
    const frame = resolver.createFrameView(
      packet("f1-2025", {
        f1: {
          grid: [
            { pitStatus: "none", onPitRoad: false },
            { pitStatus: "pitting", onPitRoad: true },
            { pitStatus: "in-pit-area", onPitRoad: true },
          ],
        } as TelemetryPacket["f1"],
      }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(
      frame.readValue<readonly string[]>(
        resolver.slot("race.competitor.pit-status"),
      ),
    ).toEqual(["none", "pitting", "in-pit-area"]);
    expect(
      frame.readValue<readonly boolean[]>(
        resolver.slot("race.competitor.on-pit-road"),
      ),
    ).toEqual([false, true, true]);
  });

  test("partitions the overloaded packet fuel field by canonical representation", () => {
    const cases = [
      ["fm-2023", "fuel.remaining-fraction", 0.375],
      ["f1-2025", "fuel.remaining-fraction", 0.375],
      ["acc", "fuel.remaining-volume", 37.5],
      ["ac-evo", "fuel.remaining-volume", 37.5],
      ["iracing", "fuel.remaining-volume", 37.5],
    ] as const;

    for (const [simulator, semanticId, fuel] of cases) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator,
        requested: [{ semanticId }],
      });
      const slot = resolver.slot(semanticId);
      const frame = resolver.createFrameView(packet(simulator, { Fuel: fuel }), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });

      expect(frame.resolveNumber(slot)).toMatchObject({
        value: fuel,
        mappingStatus: "direct",
        state: "ok",
      });
    }
  });

  test("uses iRacing packet fuel capacity before SessionInfo fallback", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "fuel.capacity" }],
    });
    const frame = resolver.createFrameView(
      packet("iracing", { FuelCapacity: 100 }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(frame.resolveNumber(resolver.slot("fuel.capacity"))).toMatchObject({
      value: 100,
      mappingStatus: "direct",
      state: "ok",
    });
  });

  test("derives canonical fuel percentages from fractions", () => {
    for (const simulator of ["fm-2023", "f1-2025"] as const) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator,
        requested: [{ semanticId: "fuel.remaining-percent" }],
      });
      const slot = resolver.slot("fuel.remaining-percent");
      const frame = resolver.createFrameView(packet(simulator, { Fuel: 0.375 }), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });

      expect(frame.readNumber(slot)).toBe(37.5);
      expect(frame.resolveNumber(slot)).toMatchObject({
        value: 37.5,
        mappingStatus: "derived",
        state: "ok",
      });
    }
  });

  test("derives only missing fuel volume and fraction representations", () => {
    const f1Resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "fuel.remaining-volume" }],
    });
    const f1Frame = f1Resolver.createFrameView(
      packet("f1-2025", { Fuel: 0.375, FuelCapacity: 100 }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(f1Frame.resolveNumber(f1Resolver.slot("fuel.remaining-volume"))).toMatchObject({
      value: 37.5,
      mappingStatus: "derived",
      state: "ok",
    });

    for (const simulator of ["acc", "ac-evo"] as const) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator,
        requested: [{ semanticId: "fuel.remaining-fraction" }],
      });
      const frame = resolver.createFrameView(
        packet(simulator, { Fuel: 30, FuelCapacity: 60 }),
        { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
      );
      expect(frame.resolveNumber(resolver.slot("fuel.remaining-fraction"))).toMatchObject({
        value: 0.5,
        mappingStatus: "derived",
        state: "ok",
      });
    }

    const forzaResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "fuel.remaining-volume" }],
    });
    const forzaFrame = forzaResolver.createFrameView(
      packet("fm-2023", { Fuel: 0.5 }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(forzaFrame.resolveNumber(forzaResolver.slot("fuel.remaining-volume"))).toMatchObject({
      value: null,
      mappingStatus: "unavailable",
      state: "missing",
    });
  });

  test("keeps direct AC Evo and iRacing fuel percentages authoritative", () => {
    const acEvoResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "ac-evo",
      requested: [{ semanticId: "fuel.remaining-percent" }],
    });
    const acEvoFrame = acEvoResolver.createFrameView(
      packet("ac-evo", {
        Fuel: 20,
        FuelCapacity: 40,
        acc: { acEvo: { fuelPercent: 62 } } as TelemetryPacket["acc"],
      }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(acEvoFrame.resolveNumber(acEvoResolver.slot("fuel.remaining-percent"))).toMatchObject({
      value: 62,
      mappingStatus: "direct",
      state: "ok",
    });

    const iracingResolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "fuel.remaining-percent" }],
    });
    const iracingFrame = iracingResolver.createFrameView(
      {
        packet: packet("iracing", { Fuel: 20, FuelCapacity: 40 }),
        nativeValues: { FuelLevelPct: 0.625 },
      },
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n },
    );
    expect(iracingFrame.resolveNumber(iracingResolver.slot("fuel.remaining-fraction"))).toMatchObject({
      value: 0.625,
      mappingStatus: "normalized",
      state: "ok",
    });
    expect(iracingFrame.resolveNumber(iracingResolver.slot("fuel.remaining-percent"))).toMatchObject({
      value: 62.5,
      mappingStatus: "derived",
      state: "ok",
    });

    const fallbackFrame = iracingResolver.createFrameView(
      {
        packet: packet("iracing", { Fuel: 20, FuelCapacity: 40 }),
        nativeValues: {},
      },
      { timestamp: { domain: "session", milliseconds: 2_000 }, updateSequence: 2n },
    );
    expect(fallbackFrame.resolveNumber(iracingResolver.slot("fuel.remaining-fraction"))).toMatchObject({
      value: 0.5,
      mappingStatus: "normalized",
      state: "ok",
    });
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
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
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
    const first = resolver.createFrameView(packet("acc", { Speed: 10 }), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });
    expect(first.readNumber(speed)).toBe(10);

    const second = resolver.createFrameView(packet("acc", { Speed: 20, TimestampMS: 2_000 }), { timestamp: { domain: "session", milliseconds: 2_000 }, updateSequence: BigInt(2_000) }, first);
    expect(second).toBe(first);
    expect(second.readNumber(speed)).toBe(20);
  });

  test("tracks pit snapshots from their own source change", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "tire.temperature.carcass.average" }],
      staleAfterMs: { "tire.temperature.carcass.average": 50 },
    });
    const slot = resolver.slot("tire.temperature.carcass.average");
    const snapshot = {
      TireCarcassTempFL: 80,
      TireCarcassTempFR: 81,
      TireCarcassTempRL: 82,
      TireCarcassTempRR: 83,
    };
    const first = resolver.createFrameView(packet("iracing", snapshot), {
      timestamp: { domain: "session", milliseconds: 1_000 },
      updateSequence: 1n,
    });
    expect(first.resolveValue(slot)).toMatchObject({
      freshness: "fresh",
      provenance: {
        sourceObservation: {
          timestamp: { domain: "session", milliseconds: 1_000 },
          updateSequence: 1n,
        },
      },
    });

    const second = resolver.createFrameView(
      packet("iracing", snapshot),
      {
        timestamp: { domain: "session", milliseconds: 1_100 },
        updateSequence: 2n,
      },
      first,
    );

    expect(second.readValue(slot)).toBeUndefined();
    expect(second.resolveValue(slot)).toMatchObject({
      value: [80, 81, 82, 83],
      mappingStatus: "simplified",
      state: "stale",
      freshness: "stale",
      confidenceComponents: { freshness: 0 },
      provenance: {
        sourceObservation: {
          timestamp: { domain: "session", milliseconds: 1_000 },
          updateSequence: 1n,
        },
      },
    });
  });

  test("reports cross-domain freshness as unknown until source changes", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "tire.temperature.carcass.average" }],
      staleAfterMs: { "tire.temperature.carcass.average": 50 },
    });
    const slot = resolver.slot("tire.temperature.carcass.average");
    const snapshot = {
      TireCarcassTempFL: 80,
      TireCarcassTempFR: 81,
      TireCarcassTempRL: 82,
      TireCarcassTempRR: 83,
    };
    const first = resolver.createFrameView(packet("iracing", snapshot), {
      timestamp: { domain: "session", milliseconds: 1_000 },
      updateSequence: 1n,
    });
    expect(first.readValue<readonly number[]>(slot)).toEqual([80, 81, 82, 83]);

    const unknown = resolver.createFrameView(
      packet("iracing", snapshot),
      {
        timestamp: { domain: "wall-clock", milliseconds: 1_800_000_000_000 },
        updateSequence: 2n,
      },
      first,
    );
    expect(unknown.readValue<readonly number[]>(slot)).toEqual([80, 81, 82, 83]);
    expect(unknown.resolveValue(slot)).toMatchObject({
      state: "ok",
      freshness: "unknown",
      confidence: null,
      confidenceComponents: { freshness: null },
      provenance: {
        sourceObservation: {
          timestamp: { domain: "session", milliseconds: 1_000 },
          updateSequence: 1n,
        },
      },
    });

    const changed = resolver.createFrameView(
      packet("iracing", { ...snapshot, TireCarcassTempFL: 84 }),
      {
        timestamp: { domain: "wall-clock", milliseconds: 1_800_000_000_001 },
        updateSequence: 3n,
      },
      unknown,
    );
    expect(changed.resolveValue(slot)).toMatchObject({
      freshness: "fresh",
      confidenceComponents: { freshness: 1 },
      provenance: {
        sourceObservation: {
          timestamp: {
            domain: "wall-clock",
            milliseconds: 1_800_000_000_001,
          },
          updateSequence: 3n,
        },
      },
    });
  });

  test("converts matching monotonic timestamps from nanoseconds for freshness", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "tire.temperature.carcass.average" }],
      staleAfterMs: { "tire.temperature.carcass.average": 50 },
    });
    const slot = resolver.slot("tire.temperature.carcass.average");
    const snapshot = {
      TireCarcassTempFL: 80,
      TireCarcassTempFR: 81,
      TireCarcassTempRL: 82,
      TireCarcassTempRR: 83,
    };
    const first = resolver.createFrameView(packet("iracing", snapshot), {
      timestamp: { domain: "monotonic", nanoseconds: 1_000_000_000n },
      updateSequence: 1n,
    });
    expect(first.readValue<readonly number[]>(slot)).toEqual([80, 81, 82, 83]);

    const stale = resolver.createFrameView(
      packet("iracing", snapshot),
      {
        timestamp: { domain: "monotonic", nanoseconds: 1_060_000_000n },
        updateSequence: 2n,
      },
      first,
    );
    expect(stale.resolveValue(slot)).toMatchObject({
      state: "stale",
      freshness: "stale",
      confidenceComponents: { freshness: 0 },
    });
  });

  test("exposes unavailable mappings through stable slots", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [{ semanticId: "weather.wind-speed" }],
    });
    const slot = resolver.slot("weather.wind-speed");
    const frame = resolver.createFrameView(packet("f1-2025"), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });

    expect(frame.readNumber(slot)).toBeUndefined();
    expect(frame.resolveNumber(slot)).toMatchObject({
      value: null,
      mappingStatus: "unavailable",
      state: "missing",
    });
  });
});
