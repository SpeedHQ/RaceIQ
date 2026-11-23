import { describe, expect, test } from "bun:test";
import { RACE_ENGINEER_AUTOMATIC_EVENTS, RACE_ENGINEER_CALLOUT_SEMANTIC_IDS, RACE_ENGINEER_EVENT_GROUPS, RACE_ENGINEER_REFERENCE, RACE_ENGINEER_SEMANTIC_GROUPS } from "@raceiq/shared/telemetry/live/race-engineer-callout-contract";
import { RACE_ENGINEER_COVERAGE } from "@raceiq/shared/telemetry/live/race-engineer-coverage";

describe("Race Engineer callout coverage", () => {
  test("contains exact pinned event contract", () => {
    expect(RACE_ENGINEER_REFERENCE).toEqual({ host: "gitlab.com", project: "mr_belowski/CrewChiefV4", commit: "97dc39c219b94de1099242fb8a5958869083603c" });
    expect(RACE_ENGINEER_AUTOMATIC_EVENTS).toHaveLength(24);
    expect(Object.keys(RACE_ENGINEER_EVENT_GROUPS)).toHaveLength(25);
    expect(RACE_ENGINEER_EVENT_GROUPS.Spotter).toEqual(["SESSION_TIMING", "OPPONENT", "SPATIAL_SPOTTER", "PITS_STRATEGY"]);
    expect(RACE_ENGINEER_CALLOUT_SEMANTIC_IDS).toContain("timing.competitor.last-lap-valid");
    expect(RACE_ENGINEER_SEMANTIC_GROUPS.OPPONENT).toContain("race.competitor.track-surface-material");
  });

  test("never reports blanket mapped coverage", () => {
    expect(Object.values(RACE_ENGINEER_COVERAGE["fm-2023"]).some((state) => state.kind === "mapped")).toBe(false);
    expect(RACE_ENGINEER_COVERAGE.acc["timing.competitor.last-lap-time"]?.kind).toBe("mapped");
    expect(RACE_ENGINEER_COVERAGE["ac-evo"]["race.competitor.driver-name"]?.kind).toBe("source-unavailable");
    expect(RACE_ENGINEER_COVERAGE.iracing["timing.competitor.last-lap-valid"]?.kind).toBe("source-unavailable");
    expect(RACE_ENGINEER_COVERAGE["f1-2025"]["timing.lap-number"]?.kind).toBe("mapped");
  });

  test("mapped and unavailable entries carry evidence", () => {
    for (const [gameId, entries] of Object.entries(RACE_ENGINEER_COVERAGE)) {
      for (const semanticId of RACE_ENGINEER_CALLOUT_SEMANTIC_IDS) {
        const entry = entries[semanticId]!;
        if (entry.kind === "mapped") {
          expect(entry.semanticId).toBe(semanticId);
          expect(entry.referenceSources.length).toBeGreaterThan(0);
          expect(entry.raceIqSources.length).toBeGreaterThan(0);
          expect(entry.referenceSources.every((source) => source.host === "gitlab.com" && source.commit === RACE_ENGINEER_REFERENCE.commit)).toBe(true);
        } else {
          expect(entry.reasonCode.length).toBeGreaterThan(0);
          expect(entry.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
