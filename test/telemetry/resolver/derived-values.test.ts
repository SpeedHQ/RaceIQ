import { describe, expect, test } from "bun:test";
import type { TelemetryCatalogData } from "../../../shared/telemetry/catalog/contracts";
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
import { getTelemetryVariable } from "../../../shared/telemetry/catalog/query";
import { TELEMETRY_DERIVATION_VERSION } from "../../../shared/telemetry/derivations/builtins";
import type { TelemetryDerivation } from "../../../shared/telemetry/derivations/contracts";
import { compileTelemetryResolver } from "../../../shared/telemetry/resolver/compile";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";
import {
  TELEMETRY_PARSER_VERSIONS,
  TELEMETRY_RESOLVER_VERSION,
} from "../../../shared/telemetry/resolver/versions";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { packet } from "../../support/telemetry/resolver";

describe("compiled telemetry resolver derived values", () => {
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
  test("normalizes iRacing value-with-unit track length text", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "timing.track-length" }],
    });
    const slot = resolver.slot("timing.track-length");
    const frame = resolver.createFrameView(
      {
        packet: packet("iracing"),
        nativeValues: {
          "SessionInfo.WeekendInfo.TrackLength": "5.1 km",
        },
      },
      1_000,
    );

    expect(frame.resolveNumber(slot)).toMatchObject({
      value: 5_100,
      mappingStatus: "normalized",
      state: "ok",
    });
  });
  test("normalizes iRacing lap fraction from its equivalent SDK source", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "timing.lap-fraction" }],
    });
    const slot = resolver.slot("timing.lap-fraction");
    const frame = resolver.createFrameView(
      packet("iracing", {
        iracing: {
          lapDistancePct: 0.5,
        } as TelemetryPacket["iracing"],
      }),
      1_000,
    );

    expect(frame.resolveNumber(slot)).toMatchObject({
      value: 0.5,
      mappingStatus: "normalized",
      state: "ok",
      confidenceComponents: { semanticFidelity: 0.99 },
    });
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
  test("returns typed error instead of raw native data for unsupported normalization", () => {
    const semanticId = "timing.sector.current-lap.times";
    const variable = getTelemetryVariable(semanticId);
    const mapping = variable.games["f1-2025"];
    if (mapping.kind === "unavailable" || !mapping.execution) {
      throw new Error("Expected executable F1 sector-time mapping");
    }
    const catalog = {
      ...TELEMETRY_CATALOG,
      variables: TELEMETRY_CATALOG.variables.map((candidate) =>
        candidate.id === semanticId
          ? {
              ...candidate,
              games: {
                ...candidate.games,
                "f1-2025": {
                  ...mapping,
                  kind: "normalized" as const,
                  execution: {
                    ...mapping.execution,
                    kind: "conversion" as const,
                  },
                },
              },
            }
          : candidate,
      ),
    } as unknown as TelemetryCatalogData;
    const resolver = compileTelemetryResolver(catalog, {
      simulator: "f1-2025",
      requested: [{ semanticId }],
    });
    const resolved = resolver
      .createFrameView(packet("f1-2025"), 1_000)
      .resolveValue(resolver.slot(semanticId));

    expect(resolved).toMatchObject({
      value: null,
      mappingStatus: "normalized",
      state: "error",
      limitations: [
        "unsupported-normalized-executor:f1-2025:timing.sector.current-lap.times",
      ],
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
      packet("f1-2025", { TyreCompound: 7 }),
      1_000,
    );
    expect(valid.readValue<string>(slot)).toBe("7");

    const invalid = resolver.createFrameView(
      packet("f1-2025", { TyreCompound: 999 }),
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
