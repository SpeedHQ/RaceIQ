import { describe, expect, test } from "bun:test";
import { getFuelDisplaySemantic } from "../../shared/games/telemetry";
import { steerBalanceFromSignals, wheelDynamicsFrame } from "../../shared/racing/analysis/laps/physics/vehicle";

describe("semantic Analyse panel parity", () => {
  test("formats fraction fuel as percentage", () => {
    expect(getFuelDisplaySemantic(0.625, 1, { packetUnit: "fraction" })).toEqual({
      amount: 62.5,
      unit: "%",
      fillRatio: 0.625,
    });
  });

  test("formats litre fuel as litres", () => {
    expect(getFuelDisplaySemantic(18.4, 95, { packetUnit: "litre" })).toEqual({
      amount: 18.4,
      unit: "L",
      fillRatio: 18.4 / 95,
    });
  });

  test("semantic wheel dynamics preserves idle and lockup states", () => {
    const states = wheelDynamicsFrame({
      speedMps: 12,
      steer: 0,
      wheelRotationRadS: { fl: 0, fr: 0, rl: 36, rr: 36 },
      wheelRadiusM: 0.33,
    });
    expect(states.fl.state).toBe("lockup");
    expect(states.fr.state).toBe("lockup");

    const idle = wheelDynamicsFrame({
      speedMps: 0.5,
      steer: 0,
      wheelRotationRadS: { fl: 0, fr: 0, rl: 0, rr: 0 },
      wheelRadiusM: 0.33,
    });
    expect(idle.fl.state).toBe("idle");
  });

  test("semantic balance classifies front slip as understeer", () => {
    const balance = steerBalanceFromSignals({
      speedMps: 30,
      accelerationX: -7,
      yawRate: 0.2,
      slipAngles: [0.18, 0.18, 0.04, 0.04],
    });
    if (balance === null) throw new Error("Expected valid semantic balance signals");
    expect(balance.state).toBe("understeer");
  });
});
