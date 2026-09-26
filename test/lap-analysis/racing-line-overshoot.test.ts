import { describe, expect, test } from "bun:test";
import { detectLateBrakingOvershoot } from "../../shared/racing/analysis/laps/insights/driving-advanced";
import { RACING_LINE_SEMANTIC_ID, type RacingLineReference } from "../../shared/racing/analysis/laps/insights/types";
import { resolveRacingLineReference } from "../../server/lap-analysis/insights";
import type { LapPathPoint } from "../../shared/racing/tracks/path";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const RADIUS_M = 50;

function circularRacingLine(): LapPathPoint[] {
  return Array.from({ length: 360 }, (_, index) => {
    const angle = (index / 360) * Math.PI * 2;
    return {
      x: RADIUS_M * Math.sin(angle),
      z: RADIUS_M * (1 - Math.cos(angle)),
    };
  });
}
function availableReference(): RacingLineReference {
  return {
    semanticId: RACING_LINE_SEMANTIC_ID,
    source: "track-data",
    points: circularRacingLine(),
  };
}

function brakingArc(offsetAtFrame: (frame: number) => number, hz = 60): TelemetryPacket[] {
  return Array.from({ length: hz }, (_, index) => {
    const frame = index * 60 / hz;
    const angle = 0.1 + frame * 0.015;
    const outside = offsetAtFrame(frame);
    const tangentX = Math.cos(angle);
    const tangentZ = Math.sin(angle);
    return {
      TimestampMS: index * 1000 / hz,
      PositionX: RADIUS_M * Math.sin(angle) + tangentZ * outside,
      PositionZ: RADIUS_M * (1 - Math.cos(angle)) - tangentX * outside,
      Speed: 30,
      Brake: 150,
      Steer: 100,
      AccelerationX: 0,
      AngularVelocityY: 0,
      TireSlipAngleFL: 0,
      TireSlipAngleFR: 0,
      TireSlipAngleRL: 0,
      TireSlipAngleRR: 0,
    } as TelemetryPacket;
  });
}

function withLongStraights(corner: TelemetryPacket[]): TelemetryPacket[] {
  const straight = Array.from({ length: 300 }, (_, index) => ({
    ...corner[0],
    PositionX: 5 - (300 - index) * 0.5,
    PositionZ: 0,
    Brake: 0,
    Steer: 0,
  }));
  return [...straight, ...corner, ...straight].map((packet, index) => ({ ...packet, TimestampMS: index * 1000 / 60 }));
}

describe("racing-line late-braking overshoot", () => {
  test("detects sustained outward departure from the reference line", () => {
    const telemetry = brakingArc((frame) => Math.min(3, Math.max(0, frame - 15) * 0.15));

    const insight = detectLateBrakingOvershoot(telemetry, true, availableReference());

    expect(insight?.id).toBe("driving-late-braking-overshoot");
  });

  test("does not mistake an inward corner cut for an overshoot", () => {
    const telemetry = brakingArc((frame) => -Math.min(3, Math.max(0, frame - 15) * 0.15));

    expect(detectLateBrakingOvershoot(telemetry, true, availableReference())).toBeNull();
  });

  test("does not flag a stable alternative line without outward drift", () => {
    const telemetry = brakingArc(() => 3);

    expect(detectLateBrakingOvershoot(telemetry, true, availableReference())).toBeNull();
  });

  test("falls back when racing-line semantic is explicitly unavailable", () => {
    const telemetry = brakingArc((frame) => Math.min(3, Math.max(0, frame - 15) * 0.15));
    const unavailable: RacingLineReference = {
      semanticId: RACING_LINE_SEMANTIC_ID,
      source: "unavailable",
      reason: "missing-track-data",
    };

    expect(detectLateBrakingOvershoot(telemetry, true, unavailable)).toBeNull();
  });

  test("retains the same overshoot when long straights dominate the lap", () => {
    const corner = brakingArc((frame) => Math.min(3, Math.max(0, frame - 15) * 0.15));
    const standalone = detectLateBrakingOvershoot(corner, true, availableReference());
    const embedded = detectLateBrakingOvershoot(withLongStraights(corner), true, availableReference());

    expect(standalone?.frameIndices).toHaveLength(1);
    expect(embedded?.frameIndices).toHaveLength(1);
    expect(embedded!.frameIndices[0]).toBeGreaterThanOrEqual(300);
    expect(embedded!.frameIndices[0]).toBeLessThan(300 + corner.length);
    expect(embedded?.severity).toBe(standalone?.severity);
  });

  test("confident alternative lines and inward cuts override front-scrub fallback", () => {
    for (const offset of [() => 3, (frame: number) => -Math.min(3, Math.max(0, frame - 15) * 0.15)]) {
      const corner = brakingArc(offset).map((packet) => ({ ...packet, TireSlipAngleFL: 0.3, TireSlipAngleFR: 0.3 }));
      expect(detectLateBrakingOvershoot(withLongStraights(corner), true, availableReference())).toBeNull();
    }
  });

  test("brief missing projections cannot turn a known stable line into an overshoot", () => {
    const corner = brakingArc(() => 3).map((packet, index) => ({
      ...packet,
      PositionX: index >= 25 && index < 35 ? Number.NaN : packet.PositionX,
      TireSlipAngleFL: 0.3,
      TireSlipAngleFR: 0.3,
    }));

    expect(detectLateBrakingOvershoot(corner, true, availableReference())).toBeNull();
  });

  test("falls back only in the corner whose geometry is unavailable", () => {
    const available = brakingArc(() => 3).map((packet) => ({ ...packet, TireSlipAngleFL: 0.3, TireSlipAngleFR: 0.3 }));
    const unavailable = available.map((packet) => ({ ...packet, PositionX: packet.PositionX + 1000 }));
    const release = available.slice(0, 30).map((packet) => ({ ...packet, Brake: 0, Steer: 0 }));
    const telemetry = [...available, ...release, ...unavailable].map((packet, index) => ({ ...packet, TimestampMS: index * 1000 / 60 }));
    const insight = detectLateBrakingOvershoot(telemetry, true, availableReference());

    expect(insight?.frameIndices).toHaveLength(1);
    expect(insight!.frameIndices[0]).toBeGreaterThanOrEqual(90);
  });

  test("resets the outside baseline as a linked corner changes direction", () => {
    const points = Array.from({ length: 250 }, (_, x) => ({ x, z: 10 * Math.sin(x / 30) }));
    const reference: RacingLineReference = { semanticId: RACING_LINE_SEMANTIC_ID, source: "track-data", points };
    const telemetry = brakingArc(() => 0).map((packet, index) => {
      const x = 70 + index;
      const slope = Math.cos(x / 30) / 3;
      const tangentLength = Math.hypot(1, slope);
      // Same side of the path throughout: inward in the first corner, outward
      // in the second, but no outward departure within either corner.
      return {
        ...packet,
        PositionX: x + 3 * slope / tangentLength,
        PositionZ: 10 * Math.sin(x / 30) - 3 / tangentLength,
      };
    });

    expect(detectLateBrakingOvershoot(telemetry, true, reference)).toBeNull();
  });

  test("requires the same sustained departure at different sample rates", () => {
    for (const hz of [30, 60, 120]) {
      const telemetry = brakingArc((frame) => Math.min(3, Math.max(0, frame - 15) * 0.15), hz);
      const insight = detectLateBrakingOvershoot(telemetry, true, availableReference());

      expect(insight?.frameIndices).toHaveLength(1);
      expect(insight?.severity).toBe("info");
    }
  });
});

describe("racing-line semantic resolution", () => {
  test("reports bundled ACC line as available track data", () => {
    const reference = resolveRacingLineReference("acc", 0);

    expect(reference.semanticId).toBe("track.racing-line");
    expect(reference.source).toBe("track-data");
    if (reference.source === "track-data") {
      expect(reference.points.length).toBeGreaterThan(20);
    }
  });

  test("distinguishes missing track identity from missing track data", () => {
    expect(resolveRacingLineReference("acc", undefined)).toEqual({
      semanticId: "track.racing-line",
      source: "unavailable",
      reason: "missing-track-identity",
    });
    expect(resolveRacingLineReference("iracing", 0)).toEqual({
      semanticId: "track.racing-line",
      source: "unavailable",
      reason: "missing-track-data",
    });
  });
});
