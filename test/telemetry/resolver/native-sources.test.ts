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
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );

    expect(frame.readNumber(slot)).toBe(61);
  });
  test("does not return raw native units when normalized packet data is absent", () => {
    const resolver = compileTelemetryResolver<{
      packet: TelemetryPacket;
      nativeValues: Record<string, unknown>;
    }>(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [{ semanticId: "motion.speed" }],
    });
    const slot = resolver.slot("motion.speed");
    const frame = resolver.createFrameView(
      {
        packet: packet("acc", {
          Speed: undefined as unknown as number,
        }),
        nativeValues: { "Physics.speedKmh": 219.6 },
      },
      { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) },
    );

    expect(frame.readNumber(slot)).toBeUndefined();
    expect(frame.resolveNumber(slot)).toMatchObject({
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
    const firstFrame = resolver.createFrameView(nativeFrame, { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });
    const first = firstFrame.readValue<number[]>(slot)!;
    expect(first).toEqual([0.1, 0.2, 0.3, 0.4]);

    nativeValues.TireSlipRatioFL = 1.1;
    nativeValues.TireSlipRatioFR = 1.2;
    nativeValues.TireSlipRatioRL = 1.3;
    nativeValues.TireSlipRatioRR = 1.4;
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
  test("resolves canonical ACC and iRacing Live Engineer extensions", () => {
    const accResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "acc",
      requested: [
        { semanticId: "identity.player-car-index" },
        { semanticId: "identity.player-car-class-id" },
        { semanticId: "session.session-type" },
        { semanticId: "race.competitor.connected" },
      ],
    });
    const accFrame = accResolver.createFrameView(packet("acc", { acc: { broadcastPlayerCarIndex: 4, broadcastPlayerCarClassId: "gt3", broadcastSessionType: "race", broadcastConnected: [true, false] } } as never), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });
    expect(accFrame.readValue<unknown>(accResolver.slot("identity.player-car-index"))).toBe(4);
    expect(accFrame.readValue<unknown>(accResolver.slot("identity.player-car-class-id"))).toBe("gt3");
    expect(accFrame.readValue<unknown>(accResolver.slot("session.session-type"))).toBe("race");
    expect(accFrame.readValue<unknown>(accResolver.slot("race.competitor.connected"))).toEqual([true, false]);

    const iracingResolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "iracing",
      requested: [
        { semanticId: "identity.player-car-class-id" },
        { semanticId: "session.session-type" },
        { semanticId: "race.competitor.pit-status" },
        { semanticId: "race.competitor.track-location" },
      ],
    });
    const iracingFrame = iracingResolver.createFrameView(packet("iracing", { iracing: { playerCarClassId: "1", sessionType: "practice", competitorPitStatus: ["out"], competitorTrackLocationName: ["track"] } } as never), { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: BigInt(1_000) });
    expect(iracingFrame.readValue<unknown>(iracingResolver.slot("identity.player-car-class-id"))).toBe("1");
    expect(iracingFrame.readValue<unknown>(iracingResolver.slot("session.session-type"))).toBe("practice");
    expect(iracingFrame.readValue<unknown>(iracingResolver.slot("race.competitor.pit-status"))).toEqual(["out"]);
    expect(iracingFrame.readValue<unknown>(iracingResolver.slot("race.competitor.track-location"))).toEqual(["track"]);
  });
});
