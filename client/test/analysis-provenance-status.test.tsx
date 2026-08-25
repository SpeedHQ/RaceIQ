import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisUserStatusSchema, type AnalysisStatus } from "../../shared/racing/provenance/contracts";
import { AnalysisProvenanceStatusSummary, analysisStatusPresentation, type AnalysisStatusPresentation } from "../src/components/AnalysisProvenanceStatus";
import { getLocale, overwriteGetLocale } from "../src/paraglide/runtime";

const baseStatus = {
  staleReasons: [],
  activeGeneration: null,
  latestAttempt: null,
  capability: {
    mode: "exact",
    sourceKind: "raceiq-raw",
    rebuildableArtifacts: [],
    unavailableArtifacts: [],
    limitations: [],
  },
  receipt: null,
  failure: null,
} satisfies Omit<AnalysisStatus, "status">;

const STATUS_EXPECTATIONS = {
  current: {
    label: "Current",
    description: "Stored analysis matches current source, processing, and configuration.",
    variant: "success",
  },
  stale_rebuild_available: {
    label: "Rebuild available",
    description: "Source evidence is available for an exact rebuild.",
    variant: "warning",
  },
  stale_source_missing: {
    label: "Cannot rebuild",
    description: "Compatible source evidence is not available. Stored analysis remains readable.",
    variant: "danger",
  },
  rebuild_in_progress: {
    label: "Rebuild in progress",
    description: "A replacement generation is being built. Current analysis remains active until verification succeeds.",
    variant: "info",
  },
  verification_failed: {
    label: "Verification failed",
    description: "Verification failed before any generation became active.",
    variant: "danger",
  },
  incompatible: {
    label: "Incompatible",
    description: "Receipt schema or processing contract is not compatible with this RaceIQ version.",
    variant: "danger",
  },
  corrupt: {
    label: "Corrupt",
    description: "Stored outputs do not match their active receipt. Rebuild before relying on this analysis.",
    variant: "danger",
  },
} as const satisfies Record<AnalysisStatus["status"], AnalysisStatusPresentation>;

describe("AnalysisProvenanceStatus", () => {
  test("presents every schema status without render failure", () => {
    expect(Object.keys(STATUS_EXPECTATIONS).sort()).toEqual([...AnalysisUserStatusSchema.options].sort());

    const previousLocale = getLocale();
    overwriteGetLocale(() => "en");
    try {
      for (const [status, expected] of Object.entries(STATUS_EXPECTATIONS) as Array<
        [AnalysisStatus["status"], (typeof STATUS_EXPECTATIONS)[AnalysisStatus["status"]]]
      >) {
        const analysis = { ...baseStatus, status } satisfies AnalysisStatus;

        expect(analysisStatusPresentation(analysis)).toEqual(expected);

        const markup = renderToStaticMarkup(<AnalysisProvenanceStatusSummary analysis={analysis} />);
        expect(markup).toContain(expected.label);
        expect(markup).toContain(expected.description);
      }
    } finally {
      overwriteGetLocale(() => previousLocale);
    }
  });
});
