import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LAP_CLASSIFICATION,
  isPaceEligible,
  LAP_CONDITION_META,
  LAP_PHASE_META,
  lapClassificationLabel,
  lapClassificationTone,
  type LapClassification,
} from "../../shared/racing/laps/classification";

function classification(
  fields: Partial<LapClassification> = {},
): LapClassification {
  return {
    phase: fields.phase ?? "flying",
    conditions: fields.conditions ?? [],
    paceEligibility: fields.paceEligibility ?? "eligible",
  };
}

describe("lap classification metadata", () => {
  test("exports canonical phase and condition metadata", () => {
    expect(LAP_PHASE_META).toEqual({
      flying: { label: "Pace", tone: "success" },
      out: { label: "Out lap", tone: "warning" },
      in: { label: "In lap", tone: "warning" },
      pit: { label: "Pit lap", tone: "warning" },
      grid_start: { label: "Grid start", tone: "warning" },
    });
    expect(LAP_CONDITION_META).toEqual({
      caution: { label: "Caution", tone: "warning" },
      slow_zone: { label: "Slow zone", tone: "warning" },
      formation: { label: "Formation", tone: "warning" },
    });
  });

  test("defaults to flying pace eligible", () => {
    expect(DEFAULT_LAP_CLASSIFICATION).toEqual({
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
    });
    expect(isPaceEligible({})).toBe(true);
    expect(isPaceEligible({ paceEligibility: null })).toBe(true);
    expect(isPaceEligible({ paceEligibility: "excluded" })).toBe(false);
  });

  test("combines phase and conditions without redundant flying label", () => {
    expect(lapClassificationLabel(classification())).toBe("Pace");
    expect(lapClassificationLabel(classification({ conditions: ["caution"] }))).toBe("Caution");
    expect(lapClassificationLabel(classification({
      phase: "grid_start",
      conditions: ["caution"],
      paceEligibility: "excluded",
    }))).toBe("Grid start · Caution");
    expect(lapClassificationLabel(classification({
      phase: "pit",
      conditions: ["caution", "slow_zone", "formation"],
      paceEligibility: "excluded",
    }))).toBe("Pit lap · Caution · Slow zone · Formation");
  });

  test("uses success tone only for fact-free flying laps", () => {
    expect(lapClassificationTone(classification())).toBe("success");
    expect(lapClassificationTone(classification({ phase: "out", paceEligibility: "excluded" }))).toBe("warning");
    expect(lapClassificationTone(classification({ conditions: ["formation"], paceEligibility: "excluded" }))).toBe("warning");
  });
});
