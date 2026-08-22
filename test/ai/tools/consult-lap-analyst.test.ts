import { describe, expect, test } from "bun:test";

import { consultLapAnalystForSession } from "../../../server/ai/consult-lap-analyst";

const selectedLap = {
  id: 41,
  sessionId: 17,
  lapNumber: 2,
  lapTime: 90,
  isValid: true,
  gameId: "fm-2023" as const,
  trackOrdinal: 5,
  telemetry: [],
};

const selection = {
  lap: selectedLap,
  setupDecision: { status: "eligible" },
  reasonCodes: [],
} as never;

describe("consultLapAnalystForSession finding authority", () => {
  test("abstains before prompt generation when selected lap has no stored current generation", async () => {
    let requestedScope: unknown;
    const result = await consultLapAnalystForSession("fm-2023", 99, {
      loadRepresentativeLapSelection: async (sessionId) => {
        expect(sessionId).toBe(99);
        return selection;
      },
      getCurrentFindingGeneration: async (scope) => {
        requestedScope = scope;
        return null;
      },
    });

    expect(requestedScope).toEqual({
      kind: "lap",
      gameId: "fm-2023",
      sessionId: "17",
      lapId: "41",
    });
    expect(result).toEqual({
      available: false,
      summary: "No persisted current finding generation exists for the selected lap.",
      eligibilityStatus: "eligible",
      reasonCodes: [],
    });
  });

  test("rejects representative lap from another game before finding lookup", async () => {
    let findingLookupCalled = false;
    const result = await consultLapAnalystForSession("acc", 99, {
      loadRepresentativeLapSelection: async () => selection,
      getCurrentFindingGeneration: async () => {
        findingLookupCalled = true;
        return null;
      },
    });

    expect(findingLookupCalled).toBe(false);
    expect(result.available).toBe(false);
    expect(result.summary).toBe("No policy-suitable analysable lap yet for this game and session.");
  });
});
