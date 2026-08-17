import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION, type EligibilityDecisionSet, type LapQualitySummary } from "../../shared/racing/quality/contracts";
import { LapManagement } from "../src/components/track/detail/LapManagement";
import { LapStatsPanel } from "../src/components/track/detail/LapStatsPanel";
import type { TrackLap } from "../src/components/track/detail/types";

const ineligibleLap: TrackLap = {
  lapId: 1,
  lapNumber: 1,
  lapTime: 90,
  carOrdinal: 1,
  carName: "Test car",
  carClass: "Test class",
  pi: 800,
  phase: "out",
  conditions: [],
  paceEligibility: "excluded",
};

const eligibleGeneration = "sha256:track-stats-eligible";
const eligibleLap: TrackLap = {
  ...ineligibleLap,
  lapId: 2,
  lapNumber: 2,
  lapTime: 90,
  sessionId: 10,
  phase: "flying",
  paceEligibility: "eligible",
  qualityGeneration: eligibleGeneration,
  quality: {
    lifecycleState: "exact",
    facts: [],
    channelQuality: [],
    provenance: {
      schemaVersion: QUALITY_SCHEMA_VERSION,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      configurationVersion: QUALITY_CONFIG_VERSION,
      sourceGeneration: "sha256:track-stats-source",
      outputGeneration: eligibleGeneration,
    },
  } as unknown as LapQualitySummary,
  eligibility: {
    "normal-pace": {
      status: "eligible",
      policyId: "normal-pace",
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      confidence: { level: "high", score: 1 },
      reasons: [],
      evidenceIds: [],
    },
  } as unknown as EligibilityDecisionSet,
};

const raceInventory: TrackLap[] = [
  eligibleLap,
  { ...ineligibleLap, lapId: 3, lapNumber: 3, lapTime: 60, sessionId: 10 },
  { ...ineligibleLap, lapId: 4, lapNumber: 4, lapTime: 120, sessionId: 10, phase: "in" },
];

describe("Track Detail lap statistics", () => {
  test("renders an empty state when recorded laps are not pace eligible", () => {
    const markup = renderToStaticMarkup(<LapStatsPanel laps={[ineligibleLap]} sectorCount={3} />);

    expect(markup).toContain("No laps are eligible for pace statistics");
    expect(markup).not.toContain("NaN");
  });

  test("classifies full race inventory before selecting pace samples", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <LapManagement
          track={{ ordinal: 1, name: "Test track", location: "", country: "", variant: "", lengthKm: 1, hasOutline: false, createdAt: null }}
          gameId="f1-2025"
          trackLaps={raceInventory}
          filteredLaps={raceInventory}
          uniqueCars={[{ carOrdinal: 1, carName: "Test car", carClass: "Test class" }]}
          uniqueDivisions={[]}
          hasForzaTunes={false}
          hideClassCol={false}
          selectedDivision={null}
          setSelectedDivision={() => {}}
          selectedCars={new Set()}
          setSelectedCars={() => {}}
          toggleCar={() => {}}
          selectedLaps={new Set()}
          setSelectedLaps={() => {}}
          toggleLapSelect={() => {}}
          toggleAllLaps={() => {}}
          sectorCount={3}
          isF125
          hasSessionTypes
          sessionLapCounts={new Map([[10, 3]])}
          confirmDelete={false}
          setConfirmDelete={() => {}}
          deleting={false}
          handleBulkDelete={() => {}}
          sortBy="lap"
          sortAsc
          handleSort={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(markup).toMatch(/>(?:Race|Rennen)<\/button>/);
    expect(markup).toContain(">Quali</button>");
    expect(markup).toMatch(/>(?:Best|Beste)<\/div><div[^>]*>1:30\.000<\/div>/);
    expect(markup).toMatch(/>Median<\/div><div[^>]*>1:30\.000<\/div>/);
    expect(markup).toMatch(/>(?:Worst|Schlechteste)<\/div><div[^>]*>1:30\.000<\/div>/);
  });
});
