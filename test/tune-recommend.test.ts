import { describe, expect, test } from "bun:test";
import { symptomsToIntents } from "../server/ai/tune-recommend";
import {
  classifySpeedBand,
  type Balance,
  type CornerSymptom,
  type Phase,
  type PhaseSymptom,
  type SpeedBand,
  type TuneSymptoms,
} from "../server/ai/tune-symptoms";
import type { TyreDeltas } from "../server/ai/tune-symptoms";

function phase(
  p: Phase,
  balance: Balance,
  magnitude = 0.06,
  extra: Partial<PhaseSymptom> = {},
): PhaseSymptom {
  return { phase: p, balance, balanceMagnitude: magnitude, brakeLockup: false, bottoming: false, ...extra };
}

function corner(label: string, phases: PhaseSymptom[], speedBand?: SpeedBand): CornerSymptom {
  return { index: 1, label, phases, speedBand };
}

function symptoms(corners: CornerSymptom[], tyrePressure: TyreDeltas | null = null): TuneSymptoms {
  const understeer = corners.filter((c) => c.phases.some((p) => p.balance === "understeer")).map((c) => c.label);
  const oversteer = corners.filter((c) => c.phases.some((p) => p.balance === "oversteer")).map((c) => c.label);
  return {
    corners,
    aggregate: {
      balance: "neutral",
      understeerCorners: understeer,
      oversteerCorners: oversteer,
      lockupCorners: [],
      bottomingCorners: [],
      tyrePressure,
    },
  };
}

const find = (intents: ReturnType<typeof symptomsToIntents>, component: string) =>
  intents.find((i) => i.component === component);

describe("symptomsToIntents — handling rules", () => {
  test("slow understeer softens the front anti-roll bar", () => {
    const sym = symptoms([corner("T1", [phase("entry", "understeer"), phase("mid", "understeer")], "slow")]);
    const intents = symptomsToIntents(sym, "acc");
    const arb = find(intents, "Front Anti-Roll Bar");
    expect(arb).toBeDefined();
    expect(arb!.direction).toBe("decrease");
  });

  test("fast understeer trims rear wing instead of the ARB", () => {
    const sym = symptoms([corner("T5", [phase("mid", "understeer")], "fast")]);
    const intents = symptomsToIntents(sym, "acc");
    expect(find(intents, "Rear Wing")?.direction).toBe("decrease");
    expect(find(intents, "Front Anti-Roll Bar")).toBeUndefined();
  });

  test("slow mid-corner oversteer softens the rear anti-roll bar", () => {
    const sym = symptoms([corner("T2", [phase("mid", "oversteer", -0.06)], "slow")]);
    const intents = symptomsToIntents(sym, "acc");
    expect(find(intents, "Rear Anti-Roll Bar")?.direction).toBe("decrease");
  });

  test("fast oversteer adds rear wing", () => {
    const sym = symptoms([corner("T7", [phase("exit", "oversteer", -0.06)], "fast")]);
    const intents = symptomsToIntents(sym, "acc");
    expect(find(intents, "Rear Wing")?.direction).toBe("increase");
  });

  test("entry oversteer moves brake bias forward", () => {
    const sym = symptoms([corner("T3", [phase("entry", "oversteer", -0.06)], "slow")]);
    const intents = symptomsToIntents(sym, "acc");
    expect(find(intents, "Brake Bias")?.direction).toBe("increase");
  });

  test("brake lockup nets against entry oversteer on brake bias", () => {
    // Same weight entry-oversteer (bias forward, +) and lockup (bias rearward, −)
    // cancel → no brake-bias intent survives.
    const sym = symptoms([
      corner("T3", [phase("entry", "oversteer", 0.03, { brakeLockup: true })], "slow"),
    ]);
    const intents = symptomsToIntents(sym, "acc");
    expect(find(intents, "Brake Bias")).toBeUndefined();
  });
});

describe("symptomsToIntents — tyre pressure", () => {
  test("over-target ACC pressures are lowered", () => {
    const sym = symptoms([], { FL: 2.0, FR: 2.0, RL: -2.0, RR: 0.2 });
    const intents = symptomsToIntents(sym, "acc", { maxIntents: 10 });
    expect(find(intents, "Front Tyre Pressure FL")?.direction).toBe("decrease");
    expect(find(intents, "Rear Tyre Pressure RL")?.direction).toBe("increase");
    // RR delta 0.2 is under the 1.0 psi deadband → no intent.
    expect(find(intents, "Rear Tyre Pressure RR")).toBeUndefined();
  });

  test("AC-Evo has no tyre-pressure knobs (null deltas → skipped)", () => {
    const sym = symptoms([corner("T1", [phase("mid", "understeer")], "slow")], null);
    const intents = symptomsToIntents(sym, "ac-evo");
    expect(intents.every((i) => !i.component.includes("Tyre Pressure"))).toBe(true);
  });
});

describe("symptomsToIntents — driver notes", () => {
  test("unconfirmed feel note adds a flagged intent when telemetry is neutral", () => {
    const sym = symptoms([corner("T1", [phase("mid", "neutral")], "slow")]);
    const intents = symptomsToIntents(sym, "acc", { driverNotes: "loose on entry" });
    const bias = find(intents, "Brake Bias");
    expect(bias?.direction).toBe("increase");
    expect(bias?.reason).toContain("unconfirmed");
  });

  test("agreeing feel note bumps the telemetry symptom without the unconfirmed flag", () => {
    const sym = symptoms([corner("T1", [phase("mid", "understeer")], "slow")]);
    const intents = symptomsToIntents(sym, "acc", { driverNotes: "car pushes wide" });
    const arb = find(intents, "Front Anti-Roll Bar");
    expect(arb?.direction).toBe("decrease");
    expect(arb?.reason).not.toContain("unconfirmed");
  });
});

describe("symptomsToIntents — resolution", () => {
  test("caps at maxIntents strongest changes", () => {
    const sym = symptoms([
      corner("T1", [phase("mid", "understeer", 0.12)], "slow"),
      corner("T2", [phase("mid", "oversteer", -0.12)], "slow"),
      corner("T3", [phase("entry", "oversteer", -0.12)], "slow"),
    ], { FL: 3, FR: 3, RL: 3, RR: 3 });
    expect(symptomsToIntents(sym, "acc").length).toBeLessThanOrEqual(3);
  });
});

describe("classifySpeedBand", () => {
  test("bands by km/h thresholds", () => {
    expect(classifySpeedBand(80)).toBe("slow");
    expect(classifySpeedBand(130)).toBe("medium");
    expect(classifySpeedBand(200)).toBe("fast");
    expect(classifySpeedBand(undefined)).toBeUndefined();
  });
});
