import { describe, expect, test } from "bun:test";
import { KNOWN_GAME_IDS } from "../../../shared/games/ids";
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
import { getTelemetryVariable } from "../../../shared/telemetry/catalog/query";
import { TELEMETRY_DERIVATION_VERSION } from "../../../shared/telemetry/derivations/builtins";
import { compileTelemetryResolver } from "../../../shared/telemetry/resolver/compile";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "../../../shared/telemetry/resolver/versions";
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

  test("uses normalized packet values without running a derivation DAG", () => {
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
      mappingStatus: "normalized",
      confidence: 0.99,
      confidenceComponents: {
        semanticFidelity: 0.99,
        freshness: 1,
        inputCompleteness: 1,
      },
    });
    expect(resolved.provenance.derivation).toBeUndefined();
    expect(evaluations).toBe(0);
  });

  test("executes normalized fuel-percentage conversions", () => {
    for (const simulator of ["fm-2023", "f1-2025"] as const) {
      const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
        simulator,
        requested: [{ semanticId: "fuel.fuel-percent" }],
      });
      const slot = resolver.slot("fuel.fuel-percent");
      const frame = resolver.createFrameView(packet(simulator, { Fuel: 0.375 }), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });

      expect(frame.readNumber(slot)).toBe(37.5);
      expect(frame.resolveNumber(slot)).toMatchObject({
        value: 37.5,
        mappingStatus: "normalized",
        state: "ok",
      });
    }
  });

  test("normalizes Forza representative tire temperatures to Celsius", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "tire.temperature.surface.representative", required: true }],
    });
    const slot = resolver.slot("tire.temperature.surface.representative");
    const first = resolver.createFrameView(
      packet("fm-2023", { TireTempFL: 212, TireTempFR: 32, TireTempRL: 68, TireTempRR: 86 }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );
    expect(first.resolveValue<readonly number[]>(slot)).toMatchObject({
      value: [100, 0, 20, 30],
      unit: "°C",
      mappingStatus: "normalized",
      provenance: { sourceChannel: "TelemetryPacket.TireTempFL" },
    });
    const second = resolver.createFrameView(
      packet("fm-2023", { TireTempFL: 50, TireTempFR: 59, TireTempRL: 77, TireTempRR: 95 }),
      { timestamp: { domain: "session", milliseconds: 1_001 }, updateSequence: BigInt(1_001) },
      first,
    );
    expect(second.resolveValue<readonly number[]>(slot).value).toEqual([10, 15, 25, 35]);
  });

  test("resolves direct per-wheel carcass bands without losing fidelity status", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "tire.temperature.carcass.middle" }],
    });
    const slot = resolver.slot("tire.temperature.carcass.middle");
    const frame = resolver.createFrameView(
      packet("iracing", {
        TireCarcassTempMiddleFL: 80,
        TireCarcassTempMiddleFR: 81,
        TireCarcassTempMiddleRL: 82,
        TireCarcassTempMiddleRR: 83,
      }),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );

    expect(frame.resolveValue<readonly number[]>(slot)).toMatchObject({
      value: [80, 81, 82, 83],
      mappingStatus: "direct",
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
      requested: [{ semanticId: "tire.temperature.carcass.middle" }],
      staleAfterMs: { "tire.temperature.carcass.middle": 50 },
    });
    const slot = resolver.slot("tire.temperature.carcass.middle");
    const snapshot = {
      TireCarcassTempMiddleFL: 80,
      TireCarcassTempMiddleFR: 81,
      TireCarcassTempMiddleRL: 82,
      TireCarcassTempMiddleRR: 83,
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
      mappingStatus: "direct",
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
      requested: [{ semanticId: "tire.temperature.carcass.middle" }],
      staleAfterMs: { "tire.temperature.carcass.middle": 50 },
    });
    const slot = resolver.slot("tire.temperature.carcass.middle");
    const snapshot = {
      TireCarcassTempMiddleFL: 80,
      TireCarcassTempMiddleFR: 81,
      TireCarcassTempMiddleRL: 82,
      TireCarcassTempMiddleRR: 83,
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
      packet("iracing", { ...snapshot, TireCarcassTempMiddleFL: 84 }),
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
      requested: [{ semanticId: "tire.temperature.carcass.middle" }],
      staleAfterMs: { "tire.temperature.carcass.middle": 50 },
    });
    const slot = resolver.slot("tire.temperature.carcass.middle");
    const snapshot = {
      TireCarcassTempMiddleFL: 80,
      TireCarcassTempMiddleFR: 81,
      TireCarcassTempMiddleRL: 82,
      TireCarcassTempMiddleRR: 83,
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
