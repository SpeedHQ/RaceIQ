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

function brakingArc(offsetAtFrame: (frame: number) => number): TelemetryPacket[] {
  return Array.from({ length: 60 }, (_, frame) => {
    const angle = 0.1 + frame * 0.015;
    const outside = offsetAtFrame(frame);
    const tangentX = Math.cos(angle);
    const tangentZ = Math.sin(angle);
    return {
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

describe("racing-line late-braking overshoot", () => {
  test("detects sustained outward departure from the reference line", () => {
    const telemetry = brakingArc((frame) => Math.min(3, Math.max(0, frame - 15) * 0.15));

    const insight = detectLateBrakingOvershoot(telemetry, true, availableReference());

    expect(insight?.id).toBe("driving-late-braking-overshoot");
    expect(insight?.detail).toContain("reference racing line");
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
