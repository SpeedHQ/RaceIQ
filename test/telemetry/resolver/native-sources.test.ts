import { describe, expect, test } from "bun:test";
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "../../../shared/telemetry/resolver/compile";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { packet } from "../../support/telemetry/resolver";

describe("compiled telemetry resolver native sources", () => {
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
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );

    expect(frame.readValue<readonly number[]>(slot)).toEqual([0.1, 0.2, 0.3, 0.4]);
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
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );

    expect(frame.readValue<readonly number[]>(slot)).toEqual([11, 12, 13, 14]);
  });
  test("falls back from absent packet fields to native sources", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "motion.speed" }],
    });
    const slot = resolver.slot("motion.speed");
    const frame = resolver.createFrameView(
      {
        packet: packet("iracing", {
          Speed: undefined as unknown as number,
        }),
        nativeValues: { Speed: 61 },
      },
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );

    expect(frame.readNumber(slot)).toBe(61);
  });
  test("does not return native Fahrenheit when normalized packet temperatures are absent", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "fm-2023",
      requested: [{ semanticId: "tire.temperature.average" }],
    });
    const slot = resolver.slot("tire.temperature.average");
    const frame = resolver.createFrameView(
      {
        packet: packet("fm-2023", {
          TireTempFL: undefined as unknown as number,
          TireTempFR: undefined as unknown as number,
          TireTempRL: undefined as unknown as number,
          TireTempRR: undefined as unknown as number,
        }),
        nativeValues: {
          TireTempFL: 212,
          TireTempFR: 212,
          TireTempRL: 212,
          TireTempRR: 212,
        },
      },
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );

    expect(frame.readValue(slot)).toBeUndefined();
    expect(frame.resolveValue(slot)).toMatchObject({
      value: null,
      mappingStatus: "normalized",
      state: "missing",
    });
  });
  test("assembles and reuses ordered native per-wheel storage", () => {
    type NativeFrame = {
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    };
    const resolver = compileTelemetryResolver<NativeFrame>(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [{ semanticId: "brakes.brake-line-press" }],
    });
    const slot = resolver.slot("brakes.brake-line-press");
    const nativeValues = {
      LFbrakeLinePress: 0.1,
      RFbrakeLinePress: 0.2,
      LRbrakeLinePress: 0.3,
      RRbrakeLinePress: 0.4,
    };
    const nativeFrame: NativeFrame = {
      packet: packet("iracing"),
      nativeValues,
    };
    const firstFrame = resolver.createFrameView(nativeFrame, { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });
    const first = firstFrame.readValue<number[]>(slot)!;
    expect(first).toEqual([0.1, 0.2, 0.3, 0.4]);

    nativeValues.LFbrakeLinePress = 1.1;
    nativeValues.RFbrakeLinePress = 1.2;
    nativeValues.LRbrakeLinePress = 1.3;
    nativeValues.RRbrakeLinePress = 1.4;
    const secondFrame = resolver.createFrameView(nativeFrame, { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) }, firstFrame);
    const second = secondFrame.readValue<number[]>(slot)!;
    expect(second).toBe(first);
    expect(second).toEqual([1.1, 1.2, 1.3, 1.4]);
  });

  test("reads collection source paths in packet order", () => {
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "f1-2025",
      requested: [
        { semanticId: "race.competitor.driver-name" },
        { semanticId: "race.competitor.position" },
        { semanticId: "timing.competitor.gap-to-leader" },
        { semanticId: "timing.sector.competitor-last.s1" },
      ],
    });
    const frame = resolver.createFrameView(
      packet("f1-2025", {
        f1: {
          grid: [
            { name: "Alpha", position: 1, gapToLeader: 0, lastS1: 31.2 },
            { name: "Bravo", position: 2, gapToLeader: 1.5, lastS1: 32.4 },
          ],
        },
      } as never),
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );

    expect(frame.readValue<readonly string[]>(resolver.slot("race.competitor.driver-name"))).toEqual(["Alpha", "Bravo"]);
    expect(frame.readValue<readonly number[]>(resolver.slot("race.competitor.position"))).toEqual([1, 2]);
    expect(frame.readValue<readonly number[]>(resolver.slot("timing.competitor.gap-to-leader"))).toEqual([0, 1.5]);
    expect(frame.readValue<readonly number[]>(resolver.slot("timing.sector.competitor-last.s1"))).toEqual([31.2, 32.4]);
  });
});
