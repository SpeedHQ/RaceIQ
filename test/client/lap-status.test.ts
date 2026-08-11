import { describe, expect, test } from "bun:test";
import { lapStatusLabel, resolveLapStatus, type LapStatusInput } from "../../client/src/components/LapStatus";

describe("lap status", () => {
  test("invalidity takes precedence over overlapping non-pace facts", () => {
    expect(
      resolveLapStatus({
        isValid: false,
        phase: "pit",
        conditions: ["caution"],
        paceEligibility: "excluded",
        invalidReason: "telemetry distance too short",
      }),
    ).toEqual({
      kind: "invalid",
      label: "Invalid",
      detailLabel: "Short distance",
      tone: "danger",
      tooltip: "telemetry distance too short",
    });
  });

  test("grid start and caution remain visible in one status", () => {
    expect(
      resolveLapStatus({
        isValid: true,
        phase: "grid_start",
        conditions: ["caution"],
        paceEligibility: "excluded",
      }),
    ).toEqual({
      kind: "non-pace",
      label: "Grid start · Caution",
      detailLabel: "Grid start · Caution",
      tone: "warning",
      tooltip: "Grid start · Caution",
    });
  });

  test("pit and caution remain visible in one status", () => {
    expect(
      resolveLapStatus({
        isValid: true,
        phase: "pit",
        conditions: ["caution"],
        paceEligibility: "excluded",
      }).label,
    ).toBe("Pit lap · Caution");
  });

  test("pace and missing generic fields resolve as success", () => {
    expect(
      resolveLapStatus({
        isValid: true,
        phase: "flying",
        conditions: [],
        paceEligibility: "eligible",
      }),
    ).toMatchObject({
      kind: "pace",
      label: "Pace",
      tone: "success",
      tooltip: "Valid pace lap",
    });
    expect(resolveLapStatus({}).kind).toBe("pace");
  });

  test("string labels use centralized visibility policy", () => {
    const nonPace = {
      isValid: true,
      phase: "out",
      conditions: [],
      paceEligibility: "excluded",
    } satisfies LapStatusInput;
    const pace = {
      isValid: true,
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
    } satisfies LapStatusInput;

    expect(lapStatusLabel({ isValid: false }, "issues")).toBe("Invalid");
    expect(lapStatusLabel(nonPace, "issues")).toBe("Out lap");
    expect(lapStatusLabel(nonPace, "non-pace")).toBe("Out lap");
    expect(lapStatusLabel(nonPace, "pace")).toBeNull();
    expect(lapStatusLabel(pace, "issues")).toBeNull();
    expect(lapStatusLabel(pace, "pace")).toBe("Pace");
  });
});
