import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { TuneSymptoms } from "../../../server/ai/tune-symptoms";
import { symptomsToIssues, detectLiveIssues } from "../../../server/ai/tune-issues";

/** Minimal symptom fixture — only the fields symptomsToIssues reads. */
function makeSymptoms(overrides: Partial<TuneSymptoms> = {}): TuneSymptoms {
  return {
    corners: [],
    aggregate: {
      balance: "neutral",
      understeerCorners: [],
      oversteerCorners: [],
      lockupCorners: [],
      bottomingCorners: [],
      tyrePressure: null,
      tyreTemp: null,
      damper: null,
      weightTransfer: null,
    },
    ...overrides,
  };
}

/** Minimal packet fixture — only the fields detectLiveIssues reads. */
function makePacket(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    DistanceTraveled: 0,
    Speed: 0,
    Brake: 0,
    TireSlipRatioFL: 0,
    TireSlipRatioFR: 0,
    TireSlipRatioRL: 0,
    TireSlipRatioRR: 0,
    TireSlipAngleFL: 0,
    TireSlipAngleFR: 0,
    TireSlipAngleRL: 0,
    TireSlipAngleRR: 0,
    NormSuspensionTravelFL: 0,
    NormSuspensionTravelFR: 0,
    NormSuspensionTravelRL: 0,
    NormSuspensionTravelRR: 0,
    TireTempFL: 0,
    TireTempFR: 0,
    TireTempRL: 0,
    TireTempRR: 0,
    ...overrides,
  } as TelemetryPacket;
}

describe("symptomsToIssues", () => {
  test("no symptoms → no issues", () => {
    expect(symptomsToIssues(makeSymptoms())).toEqual([]);
  });

  test("understeer phase → understeer issue stamped with lap number", () => {
    const symptoms = makeSymptoms({
      corners: [
        {
          index: 0,
          label: "Turn 1",
          phases: [
            { phase: "entry", balance: "understeer", balanceMagnitude: 0.05, brakeLockup: false, bottoming: false },
            { phase: "mid", balance: "neutral", balanceMagnitude: 0, brakeLockup: false, bottoming: false },
            { phase: "exit", balance: "neutral", balanceMagnitude: 0, brakeLockup: false, bottoming: false },
          ],
        },
      ],
    });
    const issues = symptomsToIssues(symptoms, 3);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "understeer", corner: "Turn 1", lapNumber: 3, severity: "warn" });
  });

  test("large understeer magnitude escalates to critical", () => {
    const symptoms = makeSymptoms({
      corners: [
        {
          index: 0,
          label: "Turn 2",
          phases: [
            { phase: "entry", balance: "understeer", balanceMagnitude: 0.2, brakeLockup: false, bottoming: false },
          ],
        },
      ],
    });
    const issues = symptomsToIssues(symptoms);
    expect(issues[0].severity).toBe("critical");
  });

  test("brake lockup phase → critical brake-lockup issue", () => {
    const symptoms = makeSymptoms({
      corners: [
        {
          index: 1,
          label: "Turn 3",
          phases: [
            { phase: "entry", balance: "neutral", balanceMagnitude: 0, brakeLockup: true, bottoming: false },
          ],
        },
      ],
    });
    const issues = symptomsToIssues(symptoms);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "brake-lockup", severity: "critical", corner: "Turn 3" });
  });

  test("bottoming phase → warn bottoming issue", () => {
    const symptoms = makeSymptoms({
      corners: [
        {
          index: 2,
          label: "Turn 4",
          phases: [
            { phase: "mid", balance: "neutral", balanceMagnitude: 0, brakeLockup: false, bottoming: true },
          ],
        },
      ],
    });
    const issues = symptomsToIssues(symptoms);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "bottoming", severity: "warn", corner: "Turn 4" });
  });

  test("tyre pressure delta beyond warn threshold → tyre-pressure issue", () => {
    const symptoms = makeSymptoms({
      aggregate: {
        balance: "neutral",
        understeerCorners: [],
        oversteerCorners: [],
        lockupCorners: [],
        bottomingCorners: [],
        tyrePressure: { FL: 2.0, FR: 0, RL: 0, RR: 0 },
        tyreTemp: null,
        damper: null,
        weightTransfer: null,
      },
    });
    const issues = symptomsToIssues(symptoms);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "tyre-pressure", severity: "warn" });
  });

  test("tyre pressure delta beyond double warn → critical", () => {
    const symptoms = makeSymptoms({
      aggregate: {
        balance: "neutral",
        understeerCorners: [],
        oversteerCorners: [],
        lockupCorners: [],
        bottomingCorners: [],
        tyrePressure: { FL: 4.0, FR: 0, RL: 0, RR: 0 },
        tyreTemp: null,
        damper: null,
        weightTransfer: null,
      },
    });
    const issues = symptomsToIssues(symptoms);
    expect(issues[0].severity).toBe("critical");
  });
});

describe("detectLiveIssues", () => {
  test("quiescent packet → no issues", () => {
    expect(detectLiveIssues(makePacket())).toEqual([]);
  });

  test("braking with locked wheel → brake-lockup issue", () => {
    const packet = makePacket({ Brake: 1, TireSlipRatioFL: 0.3 });
    const issues = detectLiveIssues(packet);
    expect(issues.some((i) => i.kind === "brake-lockup" && i.severity === "critical")).toBe(true);
  });

  test("suspension travel over threshold → bottoming issue", () => {
    const packet = makePacket({ NormSuspensionTravelRR: 0.97 });
    const issues = detectLiveIssues(packet);
    expect(issues.some((i) => i.kind === "bottoming")).toBe(true);
  });

  test("front slip exceeds rear while cornering → understeer issue", () => {
    const packet = makePacket({ Speed: 30, TireSlipAngleFL: 0.2, TireSlipAngleFR: 0.2 });
    const issues = detectLiveIssues(packet);
    expect(issues.some((i) => i.kind === "understeer")).toBe(true);
  });

  test("rear slip exceeds front while cornering → oversteer issue", () => {
    const packet = makePacket({ Speed: 30, TireSlipAngleRL: 0.2, TireSlipAngleRR: 0.2 });
    const issues = detectLiveIssues(packet);
    expect(issues.some((i) => i.kind === "oversteer")).toBe(true);
  });

  test("near-standstill balance noise is ignored", () => {
    const packet = makePacket({ Speed: 1, TireSlipAngleFL: 0.5, TireSlipAngleFR: 0.5 });
    const issues = detectLiveIssues(packet);
    expect(issues.some((i) => i.kind === "understeer" || i.kind === "oversteer")).toBe(false);
  });

  test("ACC tyre pressure out of window → tyre-pressure issue", () => {
    const packet = makePacket({ TirePressureFrontLeft: 31 } as Partial<TelemetryPacket>);
    const issues = detectLiveIssues(packet);
    expect(issues.some((i) => i.kind === "tyre-pressure")).toBe(true);
  });

  test("FM/F1 packets without tyre pressure fields skip the pressure check", () => {
    const packet = makePacket(); // TirePressureFrontLeft undefined
    const issues = detectLiveIssues(packet);
    expect(issues.some((i) => i.kind === "tyre-pressure")).toBe(false);
  });

  test("wide tyre temp spread → tyre-temp issue", () => {
    const packet = makePacket({ TireTempFL: 90, TireTempFR: 70, TireTempRL: 75, TireTempRR: 75 });
    const issues = detectLiveIssues(packet);
    expect(issues.some((i) => i.kind === "tyre-temp")).toBe(true);
  });

  test("distanceFrac populated when trackLength given", () => {
    const packet = makePacket({ DistanceTraveled: 250, Brake: 1, TireSlipRatioFL: 0.3 });
    const issues = detectLiveIssues(packet, 1000);
    expect(issues[0].distanceFrac).toBeCloseTo(0.25);
  });

  test("distanceFrac omitted without trackLength", () => {
    const packet = makePacket({ Brake: 1, TireSlipRatioFL: 0.3 });
    const issues = detectLiveIssues(packet);
    expect(issues[0].distanceFrac).toBeUndefined();
  });
});
