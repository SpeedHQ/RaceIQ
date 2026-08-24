import type { AnalysisProvenanceReceipt, AnalysisReceiptFailure, AnalysisStatus } from "@shared/racing/provenance/contracts";
import type { Meta, StoryObj } from "@storybook/react";
import { AnalysisProvenanceDiagnostics, AnalysisProvenanceStatusSummary } from "../components/AnalysisProvenanceStatus";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

const SOURCE_HASH = `sha256:${"1".repeat(64)}`;
const OUTPUT_HASH = `sha256:${"2".repeat(64)}`;
const CONFIGURATION_HASH = `sha256:${"3".repeat(64)}`;
const CONTRACT_HASH = `sha256:${"4".repeat(64)}`;
const CATALOG_HASH = `sha256:${"5".repeat(64)}`;
const GENERATION_ID = `sha256:${"6".repeat(64)}`;

const exactCapability: AnalysisStatus["capability"] = {
  mode: "exact",
  sourceKind: "raceiq-raw",
  rebuildableArtifacts: ["laps", "race_events", "session_runs", "race_result", "quality"],
  unavailableArtifacts: [],
  limitations: [],
};

const receipt: AnalysisProvenanceReceipt = {
  receiptSchemaVersion: "analysis-receipt-v1",
  generationId: GENERATION_ID,
  artifactSetId: `sha256:${"7".repeat(64)}`,
  artifactSetType: "session_analysis",
  generation: 7,
  lifecycle: "active",
  sessionId: 233,
  participantId: "driver-44",
  evidence: {
    kind: "raceiq-raw",
    originalSourceKind: "native-live",
    objectId: "capture:session-233",
    contentHash: SOURCE_HASH,
    byteSize: 8_421_776,
    formatVersion: "raceiq-bin-v3",
    recordCounts: { frames: 18420 },
  },
  telemetryVersion: {
    catalogVersion: "telemetry-catalog-v8",
    catalogHash: CATALOG_HASH,
    catalogSchemaVersion: "telemetry-catalog-schema-v2",
    parserVersion: "packet-parser-v5",
    resolverVersion: "channel-resolver-v4",
    derivationVersion: "telemetry-derivation-v6",
  },
  analysisComponents: [
    { id: "acc-lap-detector", version: "lap-detector-v4", schemaVersion: null },
    { id: "race-event-timeline", version: "race-event-v3", schemaVersion: "race-event-schema-v3" },
    { id: "session-run-builder", version: "session-run-v2", schemaVersion: "session-run-schema-v2" },
    { id: "race-result-processor", version: "race-result-v4", schemaVersion: null },
  ],
  configuration: {
    hash: CONFIGURATION_HASH,
    effective: {
      quality: { maximumMinorGapMs: 150, minimumChannelCoverage: 0.98 },
      sourceChannelProfile: "acc-native-v4",
    },
  },
  context: {
    gameId: "acc",
    trackId: "spa",
    layoutId: "gp",
    trackDefinitionHash: null,
    cornerDefinitionHash: null,
  },
  sourceFidelity: {
    profileVersion: "source-fidelity-v2",
    decisions: ["wheel slip measured", "fuel use derived"],
  },
  outputs: [
    {
      name: "laps",
      artifactType: "laps",
      schemaVersion: "lap-analysis-v4",
      count: 12,
      contentHash: OUTPUT_HASH,
      timeCoverageMs: { start: 0, end: 5_482_000 },
      lapCoverage: { start: 1, end: 12 },
      participantCoverage: ["driver-44"],
      trackDistanceCoverageM: { start: 0, end: 7004 },
    },
    {
      name: "race events",
      artifactType: "race_events",
      schemaVersion: "race-event-schema-v3",
      count: 28,
      contentHash: `sha256:${"8".repeat(64)}`,
      timeCoverageMs: { start: 3200, end: 5_433_000 },
      lapCoverage: { start: 1, end: 12 },
      participantCoverage: ["driver-44"],
      trackDistanceCoverageM: null,
    },
    {
      name: "quality",
      artifactType: "quality",
      schemaVersion: "quality-schema-v3",
      count: 1,
      contentHash: `sha256:${"9".repeat(64)}`,
      timeCoverageMs: null,
      lapCoverage: { start: 1, end: 12 },
      participantCoverage: ["driver-44"],
      trackDistanceCoverageM: null,
    },
  ],
  canonicalInventory: null,
  warnings: ["Fuel use uses a derived channel."],
  unsupportedFields: ["suspension.damper_velocity"],
  rebuildCapability: exactCapability,
  verification: [
    { id: "source_hash", status: "passed", details: "Source hash matches capture bytes." },
    { id: "session_identity", status: "passed", details: "All outputs belong to session 233." },
    { id: "ordering", status: "passed", details: "Laps and events use canonical order." },
    { id: "coverage", status: "passed", details: "Declared coverage matches persisted outputs." },
    { id: "storage_state", status: "passed", details: "Active generation projections match receipt." },
  ],
  contractHash: CONTRACT_HASH,
  startedAt: "2026-08-20T14:08:00.000Z",
  completedAt: "2026-08-20T14:08:12.000Z",
  activatedAt: "2026-08-20T14:08:12.000Z",
};

const activeGeneration: NonNullable<AnalysisStatus["activeGeneration"]> = {
  generationId: GENERATION_ID,
  generation: 7,
  lifecycle: "active",
  receiptSchemaVersion: "analysis-receipt-v1",
  completedAt: receipt.completedAt,
  activatedAt: receipt.activatedAt,
};

const verificationFailure: AnalysisReceiptFailure = {
  code: "output_verification_failed",
  message: "Replacement output inventory did not match rebuilt artifacts.",
  failedAt: "2026-08-20T15:02:09.000Z",
  checks: [{ id: "coverage", status: "failed", details: "Race-event coverage ended before final lap." }],
};

function makeStatus(overrides: Partial<AnalysisStatus> = {}): AnalysisStatus {
  return {
    status: "current",
    staleReasons: [],
    activeGeneration,
    latestAttempt: activeGeneration,
    capability: exactCapability,
    receipt,
    failure: null,
    ...overrides,
  };
}

interface ProvenanceStoryProps {
  analysis: AnalysisStatus;
  canonicalCleanupEligible: boolean;
}

function ProvenanceStory({ analysis, canonicalCleanupEligible }: ProvenanceStoryProps) {
  return (
    <main className="min-h-screen bg-app-bg p-4 text-app-text sm:p-8">
      <Card className="mx-auto w-full max-w-2xl" size="sm">
        <CardHeader className="border-b border-app-border">
          <CardTitle>Session analysis</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0 space-y-5">
          <AnalysisProvenanceStatusSummary analysis={analysis} />
          <section aria-label="Technical diagnostics" className="min-w-0 rounded-lg border border-app-border p-3 text-app-caption">
            <AnalysisProvenanceDiagnostics analysis={analysis} canonicalCleanupEligible={canonicalCleanupEligible} />
          </section>
        </CardContent>
      </Card>
    </main>
  );
}

const meta = {
  title: "Quality/Analysis Provenance",
  component: ProvenanceStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ProvenanceStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = {
  args: { analysis: makeStatus(), canonicalCleanupEligible: true },
};

export const ExactRebuildAvailable: Story = {
  args: {
    analysis: makeStatus({ status: "stale_rebuild_available", staleReasons: ["detector_changed"], latestAttempt: activeGeneration }),
    canonicalCleanupEligible: false,
  },
};

export const LimitedRebuildAvailable: Story = {
  args: {
    analysis: makeStatus({
      status: "stale_rebuild_available",
      staleReasons: ["algorithm_changed"],
      capability: {
        mode: "limited",
        sourceKind: "canonical-archive",
        rebuildableArtifacts: ["laps", "quality"],
        unavailableArtifacts: ["race_events", "session_runs", "race_result"],
        limitations: ["Canonical reader cannot reconstruct race events or session runs."],
      },
    }),
    canonicalCleanupEligible: true,
  },
};

export const SourceMissing: Story = {
  args: {
    analysis: makeStatus({
      status: "stale_source_missing",
      staleReasons: ["source_unavailable"],
      capability: {
        mode: "unavailable",
        sourceKind: "raceiq-raw",
        rebuildableArtifacts: [],
        unavailableArtifacts: ["laps", "race_events", "session_runs", "race_result", "quality"],
        limitations: ["Source recording is not readable."],
      },
    }),
    canonicalCleanupEligible: false,
  },
};

export const InProgressWithActiveGeneration: Story = {
  args: {
    analysis: makeStatus({
      status: "rebuild_in_progress",
      latestAttempt: {
        generationId: `sha256:${"a".repeat(64)}`,
        generation: 8,
        lifecycle: "rebuild_in_progress",
        receiptSchemaVersion: "analysis-receipt-v1",
        completedAt: null,
        activatedAt: null,
      },
    }),
    canonicalCleanupEligible: true,
  },
};

export const VerificationFailedWithActiveGeneration: Story = {
  args: {
    analysis: makeStatus({
      status: "verification_failed",
      staleReasons: ["output_verification_failed"],
      latestAttempt: {
        generationId: `sha256:${"b".repeat(64)}`,
        generation: 8,
        lifecycle: "verification_failed",
        receiptSchemaVersion: "analysis-receipt-v1",
        completedAt: "2026-08-20T15:02:09.000Z",
        activatedAt: null,
      },
      failure: verificationFailure,
    }),
    canonicalCleanupEligible: true,
  },
};
export const VerificationFailedBeforeActivation: Story = {
  args: {
    analysis: makeStatus({
      status: "verification_failed",
      activeGeneration: null,
      receipt: null,
      staleReasons: ["output_verification_failed"],
      latestAttempt: {
        generationId: `sha256:${"a".repeat(64)}`,
        generation: 1,
        lifecycle: "verification_failed",
        receiptSchemaVersion: "analysis-receipt-v1",
        completedAt: "2026-08-20T15:02:09.000Z",
        activatedAt: null,
      },
      failure: verificationFailure,
    }),
    canonicalCleanupEligible: false,
  },
};

export const Incompatible: Story = {
  args: {
    analysis: makeStatus({ status: "incompatible", staleReasons: ["receipt_schema_changed", "telemetry_contract_changed"] }),
    canonicalCleanupEligible: false,
  },
};

export const Corrupt: Story = {
  args: {
    analysis: makeStatus({
      status: "corrupt",
      staleReasons: ["output_verification_failed"],
      receipt: {
        ...receipt,
        verification: receipt.verification.map((check) =>
          check.id === "storage_state" ? { ...check, status: "failed", details: "Persisted race-event count differs from receipt." } : check,
        ),
      },
    }),
    canonicalCleanupEligible: false,
  },
};
