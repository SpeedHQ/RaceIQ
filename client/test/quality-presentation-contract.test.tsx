import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import type { LapMeta, SessionLapData, SessionMeta, SessionRecap } from "../../shared/racing/sessions/types";
import { LapStatus } from "../src/components/LapStatus";
import { RecordedLaps } from "../src/components/RecordedLaps";
import { SessionRecapView } from "../src/components/SessionRecap";
import { AnalysisResultCard } from "../src/components/ai/analysis-summary";
import { SessionLapTable } from "../src/components/sessions/SessionLapTable";
import { m } from "../src/paraglide/messages";
import { getLocale, overwriteGetLocale, type Locale } from "../src/paraglide/runtime";

function renderWithLocale(locale: Locale, render: () => ReactNode): string {
  const previousLocale = getLocale();
  overwriteGetLocale(() => locale);
  try {
    return renderToStaticMarkup(render());
  } finally {
    overwriteGetLocale(() => previousLocale);
  }
}

const nonPaceLap = {
  id: 7,
  sessionId: 3,
  lapNumber: 2,
  lapTime: 91.234,
  sectorTimes: [30.123],
  trackOrdinal: 1,
  carOrdinal: 2,
  isValid: true,
  phase: "out",
  conditions: [],
  paceEligibility: "excluded",
  eligibility: null,
  quality: null,
} as unknown as LapMeta;

const session = {
  id: 3,
  trackOrdinal: 1,
  carOrdinal: 2,
  bestLapTime: 91.234,
} as unknown as SessionMeta;

type RecapQualityEvidence = Pick<
  SessionLapData,
  "quality" | "eligibility" | "qualityGeneration" | "qualitySchemaVersion" | "qualityPolicyVersion" | "qualityConfigVersion"
>;

function freshRecapQualityEvidence(generation: string): RecapQualityEvidence {
  return {
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        sourceGeneration: "sha256:recap-source",
        outputGeneration: generation,
      },
    } as LapQualitySummary,
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
    qualityGeneration: generation,
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
  };
}

const missingRecapQualityEvidence: RecapQualityEvidence = {
  quality: null,
  eligibility: null,
  qualityGeneration: null,
  qualitySchemaVersion: null,
  qualityPolicyVersion: null,
  qualityConfigVersion: null,
};

const recap = {
  sessionId: 3,
  gameId: "fm-2023",
  carName: "Test car",
  trackName: "Test track",
  carOrdinal: 2,
  trackOrdinal: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  lapsValid: 1,
  lapsTotal: 2,
  bestLapSec: 91,
  bestLapId: 1,
  timeOnTrackSec: 91,
  distanceM: null,
  sparkline: [
    {
      lapId: 1,
      lapNumber: 1,
      lapTimeSec: 91,
      isValid: true,
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
      ...missingRecapQualityEvidence,
    },
    {
      lapId: 2,
      lapNumber: 2,
      lapTimeSec: 92,
      isValid: true,
      phase: "in",
      conditions: [],
      paceEligibility: "excluded",
      ...missingRecapQualityEvidence,
    },
  ],
  theoretical: null,
  sectorStarts: null,
  improvementSec: null,
  consistency: null,
  personalBest: null,
  sectors: null,
} satisfies SessionRecap;

const paceRecap = {
  ...recap,
  lapsValid: 2,
  timeOnTrackSec: 183,
  sparkline: recap.sparkline.map((lap) => ({
    ...lap,
    phase: "flying" as const,
    paceEligibility: "eligible" as const,
    ...freshRecapQualityEvidence(`sha256:recap-${lap.lapId}`),
  })),
} satisfies SessionRecap;

const insufficientFreshPaceRecap = {
  ...paceRecap,
  sparkline: [
    paceRecap.sparkline[0]!,
    {
      ...paceRecap.sparkline[1]!,
      qualityGeneration: "sha256:stale-generation",
    },
    {
      ...paceRecap.sparkline[1]!,
      lapId: 3,
      lapNumber: 3,
      ...missingRecapQualityEvidence,
    },
  ],
} satisfies SessionRecap;

describe("client quality presentation contracts", () => {
  test("localizes indicator labels and exposes invalid detail to assistive technology", () => {
    const english = renderWithLocale("en", () => <LapStatus lap={{ isValid: false, invalidReason: "too few telemetry packets" }} presentation="indicator" />);
    const german = renderWithLocale("de", () => <LapStatus lap={{ isValid: false, invalidReason: "too few telemetry packets" }} presentation="indicator" />);

    expect(english).toContain('title="No telemetry"');
    expect(english).toContain('aria-label="Invalid: No telemetry"');
    expect(english).toContain('role="img"');
    expect(german).toContain('title="Keine Telemetrie"');
    expect(german).toContain('aria-label="Ungültig: Keine Telemetrie"');
  });

  test("keeps deletion available when regeneration eligibility blocks generation", () => {
    const markup = renderWithLocale("de", () => (
      <AnalysisResultCard
        title="Vergleich"
        dotClass="bg-app-accent"
        hasResult
        loading={false}
        error={null}
        runLabel="Start"
        loadingLabel="Laden"
        retryLabel="Erneut versuchen"
        onRun={() => {}}
        onRetry={() => {}}
        onRegenerate={() => {}}
        onDelete={() => {}}
        deleteLabel={m.compare_delete_inputs()}
        generationDisabled
        deletionDisabled={false}
        disabledReason="Nicht geeignet"
      />
    ));
    const regenerate = markup.match(/<button[^>]*aria-label="Neu erstellen"[^>]*>/)?.[0] ?? "";
    const remove = markup.match(/<button[^>]*aria-label="Eingabenvergleich löschen"[^>]*>/)?.[0] ?? "";

    expect(regenerate).toContain('disabled=""');
    expect(remove).not.toBe("");
    expect(remove).not.toContain('disabled=""');
  });

  test("uses corner-trace badge for SessionLapTable analyse action", () => {
    const markup = renderWithLocale("en", () => (
      <QueryClientProvider client={new QueryClient()}>
        <SessionLapTable
          session={session}
          laps={[nonPaceLap]}
          sectorCount={1}
          lapSortKey="lap"
          lapSortDir="asc"
          toggleLapSort={() => {}}
          selectedLaps={new Set()}
          toggleLapSelection={() => {}}
        />
      </QueryClientProvider>
    ));

    expect(markup).toContain('aria-label="Telemetry quality: Corner trace —');
    expect(markup).not.toContain('aria-label="Telemetry quality: Normal pace —');
  });

  test("renders Pace section from fresh canonical eligible recap laps", () => {
    const markup = renderWithLocale("en", () => <SessionRecapView recap={paceRecap} gameId="fm-2023" showTrackMap={false} onCopy={() => {}} />);

    expect(markup).toContain(">Pace<");
    expect(markup).toContain('aria-label="Pace"');
  });

  test("excludes stale and missing recap evidence and suppresses Pace with fewer than two fresh samples", () => {
    const markup = renderWithLocale("en", () => <SessionRecapView recap={insufficientFreshPaceRecap} gameId="fm-2023" showTrackMap={false} onCopy={() => {}} />);

    expect(markup).not.toContain(">Pace<");
    expect(markup).not.toContain('aria-label="Pace"');
  });

  test("mutes non-pace sector rankings and localizes delete action", () => {
    const markup = renderWithLocale("de", () => (
      <QueryClientProvider client={new QueryClient()}>
        <RecordedLaps laps={[nonPaceLap]} />
      </QueryClientProvider>
    ));

    expect(markup).toMatch(/<span class="[^"]*text-app-text-muted[^"]*">30\.123<\/span>/);
    expect(markup).not.toMatch(/<span class="[^"]*lap-pace-best[^"]*">30\.123<\/span>/);
    expect(markup).toContain('aria-label="Löschen"');
  });
});
