import { describe, test, expect } from "bun:test";
import type { TuneSymptoms } from "../../../server/ai/tune-symptoms";
import { symptomsToIssues, detectLiveIssues } from "../../../server/ai/tune-issues";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";

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

function sample(values: SemanticTelemetrySample["values"] = {}): SemanticTelemetrySample {
  return {
    sequence: "1",
    observedAtMs: 1,
    values: {
      "timing.distance-traveled": 0,
      "motion.speed": 0,
      "inputs.brake": 0,
      "tires.tire-slip-ratio": [0, 0, 0, 0],
      "tires.tire-slip-angle": [0, 0, 0, 0],
      "suspension.norm-suspension-travel": [0, 0, 0, 0],
      ...values,
    },
  };
}

describe("symptomsToIssues", () => {
  test("emits structured corner issues", () => {
    const issues = symptomsToIssues(
      makeSymptoms({
        corners: [
          {
            index: 0,
            label: "Turn 1",
            phases: [
              { phase: "entry", balance: "understeer", balanceMagnitude: 0.05 },
              { phase: "mid", brakeLockup: true },
              { phase: "exit", bottoming: true },
            ],
          },
        ],
      }),
      3,
    );
    expect(issues).toHaveLength(3);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "understeer", corner: "Turn 1", lapNumber: 3, severity: "warn" }),
        expect.objectContaining({ kind: "brake-lockup", severity: "critical" }),
        expect.objectContaining({ kind: "bottoming", severity: "warn" }),
      ]),
    );
  });

  test("does not invent balance when semantic balance is unavailable", () => {
    expect(
      symptomsToIssues(
        makeSymptoms({
          corners: [{ index: 0, label: "Turn 1", phases: [{ phase: "entry" }] }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("detectLiveIssues", () => {
  test("quiescent semantic sample emits no issues", () => {
    expect(detectLiveIssues("acc", sample())).toEqual([]);
  });

  test("detects canonical wheel channels", () => {
    const issues = detectLiveIssues(
      "acc",
      sample({
        "timing.distance-traveled": 250,
        "motion.speed": 30,
        "inputs.brake": 255,
        "tires.tire-slip-ratio": [0.3, 0, 0, 0],
        "tires.tire-slip-angle": [0.2, 0.2, 0, 0],
        "suspension.norm-suspension-travel": [0, 0, 0, 0.97],
        "tires.tire-pressure": [31, 27.5, 27.5, 27.5],
        "tire.temperature.carcass.average": [90, 70, 75, 75],
      }),
      1000,
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "brake-lockup", distanceFrac: 0.25 }),
        expect.objectContaining({ kind: "bottoming" }),
        expect.objectContaining({ kind: "understeer" }),
        expect.objectContaining({ kind: "tyre-pressure" }),
        expect.objectContaining({ kind: "tyre-temp" }),
      ]),
    );
  });

  test("suppresses only issue using malformed wheel values", () => {
    const issues = detectLiveIssues(
      "acc",
      sample({
        "inputs.brake": 255,
        "tires.tire-slip-ratio": [0.3, 0, 0],
        "suspension.norm-suspension-travel": [0, 0, 0, 0.97],
      }),
    );
    expect(issues.some((issue) => issue.kind === "brake-lockup")).toBe(false);
    expect(issues.some((issue) => issue.kind === "bottoming")).toBe(true);
  });
});
