import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@shared/games/init";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import { detectAbsActivation, detectTractionControlActivation } from "@shared/racing/analysis/laps/insights/electronics";
import type { KunosExtendedData } from "@shared/telemetry/kunos";
import type { TelemetryPacket } from "@shared/telemetry/types";
initGameAdapters();

interface FrameOverrides {
  brake?: number;
  throttle?: number;
  rpm?: number;
  wheelRotation?: number;
  absIntervention?: number;
  tcIntervention?: number;
}

function frame(index: number, overrides: FrameOverrides = {}): TelemetryPacket {
  const interventionProvided = overrides.absIntervention !== undefined || overrides.tcIntervention !== undefined;
  return {
    TimestampMS: index * 16,
    Speed: 30,
    Accel: overrides.throttle ?? 0,
    Brake: overrides.brake ?? 0,
    Gear: 3,
    CurrentEngineRpm: overrides.rpm ?? 5_000,
    EngineMaxRpm: 8_000,
    WheelRotationSpeedFL: overrides.wheelRotation ?? 100,
    WheelRotationSpeedFR: 100,
    WheelRotationSpeedRL: 100,
    WheelRotationSpeedRR: 100,
    ...(interventionProvided
      ? {
          acc: {
            absIntervention: overrides.absIntervention ?? 0,
            tcIntervention: overrides.tcIntervention ?? 0,
          } as KunosExtendedData,
        }
      : {}),
  } as TelemetryPacket;
}

describe("static driver-aid activation detection", () => {
  test("infers ABS intervention from repeated wheel-speed recovery pulses", () => {
    const wheelRotation = [100, 94, 100, 93, 99, 96];
    const telemetry = wheelRotation.map((rotation, index) => frame(index, { brake: 200, wheelRotation: rotation }));

    const insight = detectAbsActivation(telemetry, false);

    expect(insight?.id).toBe("driving-abs-activation");
    expect(insight?.detail).toBe("1 inferred ABS intervention from wheel-speed pulsing under braking");
  });

  test("infers traction-control intervention from repeated RPM cuts at steady throttle", () => {
    const rpm = [5_000, 4_700, 5_000, 4_650, 5_000, 5_050];
    const telemetry = rpm.map((value, index) => frame(index, { throttle: 220, rpm: value }));

    const insight = detectTractionControlActivation(telemetry, false);

    expect(insight?.id).toBe("driving-traction-control-activation");
    expect(insight?.detail).toBe("1 inferred Traction Control intervention from RPM cuts under sustained throttle");
  });

  test("uses native intervention channels when provided", () => {
    const telemetry = Array.from({ length: 8 }, (_, index) =>
      frame(index, {
        absIntervention: index >= 2 && index <= 4 ? 1 : 0,
        tcIntervention: index >= 5 && index <= 6 ? 1 : 0,
      }),
    );

    expect(detectAbsActivation(telemetry, true)?.detail).toBe("1 ABS intervention reported by game");
    expect(detectTractionControlActivation(telemetry, true)?.detail).toBe("1 Traction Control intervention reported by game");
  });

  test("does not infer activations over inactive native channels", () => {
    const wheelRotation = [100, 94, 100, 93, 99, 96];
    const rpm = [5_000, 4_700, 5_000, 4_650, 5_000, 5_050];
    const telemetry = wheelRotation.map((rotation, index) =>
      frame(index, {
        brake: 200,
        throttle: 220,
        rpm: rpm[index],
        wheelRotation: rotation,
        absIntervention: 0,
        tcIntervention: 0,
      }),
    );

    expect(detectAbsActivation(telemetry, true)).toBeNull();
    expect(detectTractionControlActivation(telemetry, true)).toBeNull();
  });

  test("adds inferred activations to static lap analysis", () => {
    const absRotation = [100, 94, 100, 93, 99, 96];
    const tcRpm = [5_000, 4_700, 5_000, 4_650, 5_000, 5_050];
    const telemetry = [
      ...absRotation.map((rotation, index) => frame(index, { brake: 200, wheelRotation: rotation })),
      ...tcRpm.map((rpm, index) => frame(index + absRotation.length, { throttle: 220, rpm })),
    ];

    const insightIds = analyzeLap(telemetry, "fm-2023").map((insight) => insight.id);

    expect(insightIds).toContain("driving-abs-activation");
    expect(insightIds).toContain("driving-traction-control-activation");
  });
});
