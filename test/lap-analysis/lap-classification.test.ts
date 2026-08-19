import { describe, expect, test } from "bun:test";
import {
  classifyLap,
  DEFAULT_LAP_CLASSIFICATION,
  isPaceEligible,
  LAP_CONDITION_META,
  LAP_PHASE_META,
  lapClassificationLabel,
  lapClassificationTone,
  type LapClassification,
  type LapTimelineClassificationContext,
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

function timeline(
  fields: Partial<LapTimelineClassificationContext> = {},
): LapTimelineClassificationContext {
  return {
    pitPhase: fields.pitPhase ?? null,
    conditions: fields.conditions ?? [],
    gridStart: fields.gridStart ?? false,
  };
}

describe("lap classification metadata", () => {
  test("exports canonical phase and condition metadata", () => {
    expect(LAP_PHASE_META).toEqual({
      flying: { label: "Pace" },
      out: { label: "Out lap" },
      in: { label: "In lap" },
      pit: { label: "Pit lap" },
      grid_start: { label: "Grid start" },
    });
    expect(LAP_CONDITION_META).toEqual({
      caution: { label: "Caution" },
      slow_zone: { label: "Slow zone" },
      formation: { label: "Formation" },
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

describe("classifyLap", () => {
  test("classifies authoritative pit timeline phases", () => {
    expect(classifyLap(timeline({ pitPhase: "in" }))).toEqual({
      phase: "in",
      conditions: [],
      paceEligibility: "excluded",
    });
    expect(classifyLap(timeline({ pitPhase: "out" }))).toEqual({
      phase: "out",
      conditions: [],
      paceEligibility: "excluded",
    });
    expect(classifyLap(timeline({ pitPhase: "pit" }))).toEqual({
      phase: "pit",
      conditions: [],
      paceEligibility: "excluded",
    });
  });

  test("consumes coordinator grid-start context", () => {
    expect(classifyLap(timeline({ gridStart: true }))).toEqual({
      phase: "grid_start",
      conditions: [],
      paceEligibility: "excluded",
    });
    expect(classifyLap(timeline()).phase).toBe("flying");
  });

  test("preserves grid-start and caution overlap", () => {
    expect(
      classifyLap(timeline({ gridStart: true, conditions: ["caution"] })),
    ).toEqual({
      phase: "grid_start",
      conditions: ["caution"],
      paceEligibility: "excluded",
    });
  });

  test("preserves out-lap and yellow overlap", () => {
    expect(
      classifyLap(timeline({ pitPhase: "out", conditions: ["caution"] })),
    ).toEqual({
      phase: "out",
      conditions: ["caution"],
      paceEligibility: "excluded",
    });
  });

  test("preserves pit-lap and safety-car overlap", () => {
    expect(
      classifyLap(timeline({ pitPhase: "pit", conditions: ["caution"] })),
    ).toEqual({
      phase: "pit",
      conditions: ["caution"],
      paceEligibility: "excluded",
    });
  });

  test("preserves coordinator condition order and removes duplicates", () => {
    expect(
      classifyLap(
        timeline({
          conditions: ["caution", "slow_zone", "formation", "caution"],
        }),
      ),
    ).toEqual({
      phase: "flying",
      conditions: ["caution", "slow_zone", "formation"],
      paceEligibility: "excluded",
    });
  });

  test("uses eligible flying phase when source exposes no non-pace signal", () => {
    expect(classifyLap(timeline())).toEqual({
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
    });
  });
});
