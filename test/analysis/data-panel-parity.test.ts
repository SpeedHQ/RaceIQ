import { describe, expect, test } from "bun:test";
import { getFuelDisplaySemantic } from "../../shared/games/telemetry";
import { semanticWheelDynamics, steerBalanceFromSignals } from "../../shared/racing/analysis/laps/physics/vehicle";

describe("semantic Analyse panel parity", () => {
  test("formats fraction fuel as percentage", () => {
    expect(getFuelDisplaySemantic({ remainingFraction: 0.625 })).toEqual({
      amount: 62.5,
      unit: "%",
      fillRatio: 0.625,
    });
  });

  test("formats litre fuel as litres", () => {
    expect(getFuelDisplaySemantic({
      remainingVolumeL: 18.4,
      capacityL: 95,
    })).toEqual({
      amount: 18.4,
      unit: "L",
      fillRatio: 18.4 / 95,
    });
  });

  test("prefers finite volume and clamps the available fraction", () => {
    expect(getFuelDisplaySemantic({
      remainingVolumeL: 98,
      remainingFraction: 1.1,
      capacityL: 95,
    })).toEqual({
      amount: 98,
      unit: "L",
      fillRatio: 1,
    });
  });

  test("falls back to a finite fraction when volume is not finite", () => {
    expect(getFuelDisplaySemantic({
      remainingVolumeL: Number.NaN,
      remainingFraction: 0.4,
    })).toEqual({
      amount: 40,
      unit: "%",
      fillRatio: 0.4,
    });
  });

  test("semantic wheel dynamics preserves idle and lockup states", () => {
    const states = semanticWheelDynamics({
      speedMps: 12,
      steeringRatio: 0,
      wheelRotationRadS: { fl: 0, fr: 0, rl: 36, rr: 36 },
      wheelRadiusM: 0.33,
    });
    expect(states.fl.state).toBe("lockup");
    expect(states.fr.state).toBe("lockup");

    const idle = semanticWheelDynamics({
      speedMps: 0.5,
      steeringRatio: 0,
      wheelRotationRadS: { fl: 0, fr: 0, rl: 0, rr: 0 },
      wheelRadiusM: 0.33,
    });
    expect(idle.fl.state).toBe("idle");
  });

  test("semantic wheel dynamics uses steering ratio directly", () => {
    const wheelRotationRadS = { fl: 35, fr: 35, rl: 35, rr: 35 };
    const straight = semanticWheelDynamics({
      speedMps: 10,
      steeringRatio: 0,
      wheelRotationRadS,
      wheelRadiusM: 0.33,
    });
    const fullRight = semanticWheelDynamics({
      speedMps: 10,
      steeringRatio: 1,
      wheelRotationRadS,
      wheelRadiusM: 0.33,
    });

    expect(straight.fr.state).toBe("spin");
    expect(fullRight.fr.state).toBe("grip");
  });

  test("semantic balance classifies front slip as understeer", () => {
    const balance = steerBalanceFromSignals({
      speedMps: 30,
      accelerationX: -7,
      yawRate: 0.2,
      slipAngles: [0.18, 0.18, 0.04, 0.04],
    });
    expect(balance.state).toBe("understeer");
  });
});
