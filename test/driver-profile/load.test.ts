import { describe, expect, spyOn, test } from "bun:test";

import * as LapReadQueries from "../../server/db/lap-read-queries";
import { loadDriverProfile, selectCurrentDriverProfileEvidence } from "../../server/driver-profile/load";
import { isEligibilityUsable } from "../../shared/racing/quality/policies";
import { lap } from "../support/driver-profile/factories";

describe("driver profile evidence selection", () => {
  test("five current eligible rows make the profile pool usable", () => {
    const selection = selectCurrentDriverProfileEvidence(
      Array.from({ length: 5 }, (_, index) => lap(index + 1)),
      "fm-2023",
    );

    expect(isEligibilityUsable(selection.decision)).toBe(true);
    expect(selection.candidates.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("stale or actively manual-excluded fifth row cannot satisfy the minimum", () => {
    const firstFour = Array.from({ length: 4 }, (_, index) => lap(index + 1));
    const rejectedFifths = [
      lap(5, { qualityStale: true }),
      lap(5, { experimentExcluded: true, experimentExcludedSource: "manual" }),
    ];

    for (const fifth of rejectedFifths) {
      const selection = selectCurrentDriverProfileEvidence([...firstFour, fifth], "fm-2023");
      expect(isEligibilityUsable(selection.decision)).toBe(false);
      expect(selection.decision.reasons.map(({ code }) => code)).toContain("insufficient_sample_pool");
      expect(selection.candidates).toEqual([]);
    }
  });

  test("auto-excluded and manually re-included rows remain admissible", () => {
    const selection = selectCurrentDriverProfileEvidence(
      [
        lap(1),
        lap(2),
        lap(3),
        lap(4, { experimentExcluded: true, experimentExcludedSource: "auto" }),
        lap(5, { experimentExcluded: false, experimentExcludedSource: "manual" }),
      ],
      "fm-2023",
    );

    expect(isEligibilityUsable(selection.decision)).toBe(true);
    expect(selection.candidates.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("four selected rows return a non-runnable fingerprint while current rejected rows remain in trend totals", async () => {
    const pool = [
      lap(1),
      lap(2),
      lap(3),
      lap(4),
      lap(5, { isValid: false }),
      lap(6, { paceEligibility: "excluded", phase: "out" }),
    ];
    const getScope = spyOn(LapReadQueries, "getLapMetaForProfileScope").mockResolvedValue(pool);
    const getLapsByIds = spyOn(LapReadQueries, "getLapsByIds").mockResolvedValue([]);

    try {
      const fingerprint = await loadDriverProfile({ gameId: "fm-2023" });
      expect(fingerprint.ok).toBe(false);
      expect(fingerprint.eligibility?.reasons.map(({ code }) => code)).toContain("insufficient_sample_pool");
      expect(fingerprint.trend.recent.total).toBe(6);
      expect(fingerprint.trend.recent.laps.find(({ id }) => id === 5)?.relativePacePct).toBeNull();
      expect(fingerprint.trend.recent.laps.find(({ id }) => id === 6)?.relativePacePct).toBeNull();
      expect(getLapsByIds).not.toHaveBeenCalled();
    } finally {
      getScope.mockRestore();
      getLapsByIds.mockRestore();
    }
  });
});
