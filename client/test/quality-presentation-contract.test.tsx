import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION, type EligibilityDecisionSet, type LapQualitySummary } from "../../shared/racing/quality/contracts";
import { isEligibilityUsable, resolveEligibilityDecision } from "../../shared/racing/quality/policies";
import type { LapMeta, SessionLapData, SessionMeta, SessionRecap } from "../../shared/racing/sessions/types";
import { LapQualityBadge, QualityRebuildStatus, type QualityRebuildStatusProps } from "../src/components/LapQualityBadge";
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
function renderRebuildStatus(props: Partial<QualityRebuildStatusProps>): string {
  return renderWithLocale("en", () => (
    <QualityRebuildStatus
      action={undefined}
      statusPending={false}
      statusFetching={false}
      statusError={false}
      rebuildPending={false}
      rebuildError={false}
      rebuildSuccess={false}
      onRetry={() => {}}
      onRebuild={() => {}}
      {...props}
    />
  ));
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
const missingLap = {
  ...nonPaceLap,
  phase: "flying",
  paceEligibility: "eligible",
  qualityStale: false,
} as unknown as LapMeta;
const staleLap = {
  ...missingLap,
  qualityStale: true,
} as unknown as LapMeta;

const session = {
  id: 3,
  trackOrdinal: 1,
  carOrdinal: 2,
  bestLapTime: 91.234,
} as unknown as SessionMeta;

type RecapQualityEvidence = Pick<SessionLapData, "quality" | "eligibility" | "qualityGeneration" | "qualitySchemaVersion" | "qualityPolicyVersion" | "qualityConfigVersion">;

function freshRecapQualityEvidence(generation: string): RecapQualityEvidence {
  return {
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        sourceGeneration: `sha256:${"c".repeat(64)}`,
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
    ...freshRecapQualityEvidence(`sha256:${lap.lapId.toString(16).padStart(64, "0")}`),
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
  test("renders missing and stale quality as distinct localized evidence", () => {
    const missingDecision = resolveEligibilityDecision(missingLap, "corner-trace");
    const staleDecision = resolveEligibilityDecision(staleLap, "corner-trace");
    const englishMissing = renderWithLocale("en", () => (
      <QueryClientProvider client={new QueryClient()}>
        <LapQualityBadge lap={missingLap} />
      </QueryClientProvider>
    ));
    const englishStale = renderWithLocale("en", () => (
      <QueryClientProvider client={new QueryClient()}>
        <LapQualityBadge lap={staleLap} />
      </QueryClientProvider>
    ));
    const germanMissing = renderWithLocale("de", () => (
      <QueryClientProvider client={new QueryClient()}>
        <LapQualityBadge lap={missingLap} />
      </QueryClientProvider>
    ));
    const germanStale = renderWithLocale("de", () => (
      <QueryClientProvider client={new QueryClient()}>
        <LapQualityBadge lap={staleLap} />
      </QueryClientProvider>
    ));

    expect(missingDecision.reasons.map(({ code }) => code)).toEqual(["quality_not_rebuilt"]);
    expect(staleDecision.reasons.map(({ code }) => code)).toEqual(["quality_stale"]);
    expect(englishMissing).toContain('data-quality-level="unknown"');
    expect(englishMissing).toContain(">Telemetry unknown<");
    expect(englishMissing).toContain("— Unknown: Quality has not been rebuilt from source evidence.");
    expect(englishStale).toContain('data-quality-level="stale"');
    expect(englishStale).toContain(">Stale<");
    expect(englishStale).toContain("Stored quality is out of date.");
    expect(germanMissing).toContain('data-quality-level="unknown"');
    expect(germanMissing).toContain(">Telemetrie unbekannt<");
    expect(germanStale).toContain('data-quality-level="stale"');
    expect(germanStale).toContain(">Veraltet<");
  });

  test("blocks generation while retaining recorded-lap inspection and deletion for missing and stale quality", () => {
    for (const lap of [missingLap, staleLap]) {
      const decision = resolveEligibilityDecision(lap, "corner-trace");
      const markup = renderWithLocale("en", () => (
        <QueryClientProvider client={new QueryClient()}>
          <>
            <RecordedLaps laps={[lap]} />
            <AnalysisResultCard
              title="Comparison"
              dotClass="bg-app-accent"
              hasResult
              loading={false}
              error={null}
              runLabel="Start"
              loadingLabel="Loading"
              retryLabel="Retry"
              onRun={() => {}}
              onRetry={() => {}}
              onRegenerate={() => {}}
              onDelete={() => {}}
              deleteLabel="Delete generated analysis"
              generationDisabled={!isEligibilityUsable(decision)}
              deletionDisabled={false}
              disabledReason="Not suitable"
            />
          </>
        </QueryClientProvider>
      ));
      const analyseButtons = markup.match(/<button[^>]*title="Analyse"[^>]*>/g) ?? [];
      const regenerate = markup.match(/<button[^>]*aria-label="Regenerate"[^>]*>/)?.[0] ?? "";
      const remove = markup.match(/<button[^>]*aria-label="Delete generated analysis"[^>]*>/)?.[0] ?? "";

      expect(decision.status).toBe("unknown");
      expect(analyseButtons).toHaveLength(1);
      expect(analyseButtons[0]).not.toContain('disabled=""');
      expect(regenerate).toContain('disabled=""');
      expect(remove).not.toBe("");
      expect(remove).not.toContain('disabled=""');
    }
  });

  test("keeps non-pace Analyse navigation enabled while showing corner-trace quality badges", () => {
    const markup = renderWithLocale("en", () => (
      <QueryClientProvider client={new QueryClient()}>
        <>
          <RecordedLaps laps={[nonPaceLap]} />
          <SessionLapTable session={session} laps={[nonPaceLap]} sectorCount={1} lapSortKey="lap" lapSortDir="asc" toggleLapSort={() => {}} selectedLaps={new Set()} toggleLapSelection={() => {}} />
        </>
      </QueryClientProvider>
    ));
    const analyseButtons = markup.match(/<button[^>]*title="Analyse"[^>]*>/g) ?? [];

    expect(markup.match(/aria-label="Telemetry quality: Corner trace —/g)?.length).toBe(2);
    expect(markup).not.toContain('aria-label="Telemetry quality: Normal pace —');
    expect(analyseButtons).toHaveLength(2);
    for (const button of analyseButtons) expect(button).not.toContain('disabled=""');
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

  test("announces loading, rebuild progress, success, and current status", () => {
    const loading = renderRebuildStatus({ action: "reprocess", statusPending: true });
    const pending = renderRebuildStatus({ action: "reprocess", rebuildPending: true });
    const success = renderRebuildStatus({ action: "reprocess", rebuildSuccess: true });
    const current = renderRebuildStatus({ action: "current" });

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-live="polite"');
    expect(loading).toContain("Checking quality status…");
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("Rebuilding…");
    expect(pending.match(/<button[^>]*>/)?.[0]).toContain('disabled=""');
    expect(success).toContain('role="status"');
    expect(success).toContain("Quality rebuilt");
    expect(success.match(/<button[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(current).toContain('role="status"');
    expect(current).toContain("Quality is up to date.");
  });

  test("prioritizes rebuild errors and retains retry and available rebuild actions", () => {
    const rebuildError = renderRebuildStatus({ action: "reprocess", statusError: true, rebuildError: true });
    const statusError = renderRebuildStatus({ action: "reprocess", statusError: true });
    const unavailable = renderRebuildStatus({ action: "unavailable" });

    expect(rebuildError).toContain('role="alert"');
    expect(rebuildError).toContain("Quality rebuild failed");
    expect(rebuildError).not.toContain("Could not load session quality status.");
    expect(rebuildError).toContain(">Rebuild quality<");
    expect(statusError).toContain('role="alert"');
    expect(statusError).toContain("Could not load session quality status.");
    expect(statusError).toContain(">Retry<");
    expect(statusError).toContain(">Rebuild quality<");
    expect(unavailable).toContain('role="alert"');
    expect(unavailable).toContain("Source recording unavailable; quality cannot be rebuilt.");
    expect(unavailable).not.toContain(">Rebuild quality<");
  });
});
