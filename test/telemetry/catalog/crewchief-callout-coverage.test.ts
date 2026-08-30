import { describe, expect, test } from "bun:test";
import { CREWCHIEF_AUTOMATIC_EVENTS, CREWCHIEF_CALLOUT_SEMANTIC_IDS, CREWCHIEF_EVENT_GROUPS, CREWCHIEF_REFERENCE, CREWCHIEF_SEMANTIC_GROUPS } from "../../../shared/telemetry/live/crewchief-callout-contract";
import { CREWCHIEF_COVERAGE } from "../../../shared/telemetry/live/crewchief-coverage";

describe("CrewChief callout coverage", () => {
  test("contains exact pinned event contract", () => {
    expect(CREWCHIEF_REFERENCE).toEqual({ host: "gitlab.com", project: "mr_belowski/CrewChiefV4", commit: "97dc39c219b94de1099242fb8a5958869083603c" });
    expect(CREWCHIEF_AUTOMATIC_EVENTS).toHaveLength(24);
    expect(Object.keys(CREWCHIEF_EVENT_GROUPS)).toHaveLength(25);
    expect(CREWCHIEF_EVENT_GROUPS.Spotter).toEqual(["SESSION_TIMING", "OPPONENT", "SPATIAL_SPOTTER", "PITS_STRATEGY"]);
    expect(CREWCHIEF_CALLOUT_SEMANTIC_IDS).toContain("timing.competitor.last-lap-valid");
    expect(CREWCHIEF_SEMANTIC_GROUPS.OPPONENT).toContain("race.competitor.track-surface-material");
  });

  test("never reports blanket mapped coverage", () => {
    expect(Object.values(CREWCHIEF_COVERAGE["fm-2023"]).some((state) => state.kind === "mapped")).toBe(false);
    expect(CREWCHIEF_COVERAGE.acc["timing.competitor.last-lap-time"]?.kind).toBe("mapped");
    expect(CREWCHIEF_COVERAGE["ac-evo"]["race.competitor.driver-name"]?.kind).toBe("source-unavailable");
    expect(CREWCHIEF_COVERAGE.iracing["timing.competitor.last-lap-valid"]?.kind).toBe("source-unavailable");
    expect(CREWCHIEF_COVERAGE["f1-2025"]["timing.lap-number"]?.kind).toBe("mapped");
  });

  test("mapped and unavailable entries carry evidence", () => {
    for (const [gameId, entries] of Object.entries(CREWCHIEF_COVERAGE)) {
      for (const semanticId of CREWCHIEF_CALLOUT_SEMANTIC_IDS) {
        const entry = entries[semanticId]!;
        if (entry.kind === "mapped") {
          expect(entry.semanticId).toBe(semanticId);
          expect(entry.crewChiefSources.length).toBeGreaterThan(0);
          expect(entry.raceIqSources.length).toBeGreaterThan(0);
          expect(entry.crewChiefSources.every((source) => source.host === "gitlab.com" && source.commit === CREWCHIEF_REFERENCE.commit)).toBe(true);
        } else {
          expect(entry.reasonCode.length).toBeGreaterThan(0);
          expect(entry.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
