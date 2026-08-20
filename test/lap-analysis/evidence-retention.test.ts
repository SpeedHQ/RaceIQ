import { describe, expect, test } from "bun:test";
import type { EligibilityDecisionSet, EligibilityPolicyId, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION } from "../../shared/racing/quality/contracts";
import type { CanonicalArchiveAvailability, EvidenceAvailability } from "../../shared/racing/quality/retention";
import { evaluateEvidenceRetention } from "../../server/lap-analysis/evidence-retention";

const POLICY_IDS = [
  "official-timing",
  "normal-pace",
  "lap-comparison",
  "corner-trace",
  "transient-event",
  "fuel-burn",
  "tire-analysis",
  "stint-falloff",
  "setup-analysis",
  "driver-profile",
  "ml-training",
] as const satisfies readonly EligibilityPolicyId[];

const RAW_REDECODE_POLICIES = ["lap-comparison", "corner-trace", "transient-event", "ml-training"] as const;

const FULL_CANONICAL_SEMANTIC_IDS = [
  "timing.distance-traveled",
  "motion.speed",
  "inputs.accel",
  "inputs.brake",
  "inputs.steer",
  "tires.tire-slip-ratio",
  "tires.tire-slip-angle",
  "tires.wheel-rotation-speed",
  "suspension.norm-suspension-travel",
] as const;

function eligibility(): EligibilityDecisionSet {
  return Object.fromEntries(
    POLICY_IDS.map((policyId) => [
      policyId,
      {
        status: "eligible" as const,
        policyId,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        confidence: { level: "high" as const, score: 1 },
        reasons: [],
        evidenceIds: [],
      },
    ]),
  ) as unknown as EligibilityDecisionSet;
}

function currentRow(id: number = 1, decisions: EligibilityDecisionSet | null = eligibility()) {
  const generation = `sha256:${id.toString(16).padStart(64, "0")}`;
  return {
    id,
    eligibility: decisions,
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        sourceGeneration: `sha256:${"b".repeat(64)}`,
        outputGeneration: generation,
      },
    } as LapQualitySummary,
    qualityGeneration: generation,
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
  };
}

function archive(overrides: Partial<CanonicalArchiveAvailability> = {}): CanonicalArchiveAvailability {
  return {
    state: "available",
    status: "verified",
    completeness: "complete",
    semanticIds: FULL_CANONICAL_SEMANTIC_IDS,
    eventIds: ["canonical:event:1"],
    provenance: {
      archiveIdentity: "archive:v1:session-236",
      schemaIdentity: "quality-schema-v1",
      configIdentity: "quality-config-v1",
      sourceIdentity: "source:sha256:236",
      outputIdentity: "output:sha256:236",
    },
    details: "Verified canonical archive inventory",
    ...overrides,
  };
}

const cases: readonly {
  name: string;
  availability: EvidenceAvailability;
  action: "retain_raw" | "raw_removal_safe" | "raw_unavailable";
  canDeleteRaw: boolean;
  blockedBy: readonly EligibilityPolicyId[];
}[] = [
  {
    name: "raw absent and canonical archive unavailable",
    availability: {
      rawCapture: false,
      canonicalArchive: archive({ state: "unavailable", semanticIds: [], eventIds: [], provenance: null, details: "Canonical archive inventory unavailable" }),
    },
    action: "raw_unavailable",
    canDeleteRaw: false,
    blockedBy: RAW_REDECODE_POLICIES,
  },
  {
    name: "raw present with no canonical archive",
    availability: {
      rawCapture: true,
      canonicalArchive: archive({ state: "unavailable", semanticIds: [], eventIds: [], provenance: null, details: "Canonical archive inventory unavailable" }),
    },
    action: "retain_raw",
    canDeleteRaw: false,
    blockedBy: RAW_REDECODE_POLICIES,
  },
  {
    name: "raw present with verified full canonical archive",
    availability: { rawCapture: true, canonicalArchive: archive() },
    action: "raw_removal_safe",
    canDeleteRaw: true,
    blockedBy: [],
  },
  {
    name: "raw present with incomplete verified canonical archive",
    availability: {
      rawCapture: true,
      canonicalArchive: archive({ semanticIds: ["timing.distance-traveled", "motion.speed"], details: "Verified inventory omits trace channels" }),
    },
    action: "retain_raw",
    canDeleteRaw: false,
    blockedBy: ["corner-trace", "transient-event", "ml-training"],
  },
  {
    name: "raw present with unknown canonical archive state",
    availability: {
      rawCapture: true,
      canonicalArchive: archive({ state: "unknown", semanticIds: [], eventIds: [], provenance: null, details: "Inventory metadata cannot be verified" }),
    },
    action: "retain_raw",
    canDeleteRaw: false,
    blockedBy: RAW_REDECODE_POLICIES,
  },
];

describe("evidence retention evaluator", () => {
  for (const entry of cases) {
    test(entry.name, () => {
      const assessment = evaluateEvidenceRetention(236, entry.availability, [currentRow()]);

      expect(assessment).toMatchObject({
        sessionId: 236,
        action: entry.action,
        canDeleteRaw: entry.canDeleteRaw,
        blockedBy: entry.blockedBy,
        availability: entry.availability,
      });
      expect(assessment.reasons).toEqual(entry.blockedBy.length > 0 ? ["raw_redecode_required"] : []);
      for (const policyId of entry.blockedBy) {
        expect(assessment.laps[0]?.postRawRemoval[policyId]).toMatchObject({
          status: "unknown",
          reasons: [expect.objectContaining({ code: "raw_redecode_required", evidenceIds: [] })],
        });
      }
      for (const policyId of RAW_REDECODE_POLICIES) {
        if (entry.blockedBy.includes(policyId)) continue;
        expect(assessment.laps[0]?.postRawRemoval[policyId].status).toBe("eligible");
      }
    });
  }
  test("missing eligibility on any lap blocks deletion without omitting lap inventory", () => {
    const assessment = evaluateEvidenceRetention(236, { rawCapture: true, canonicalArchive: archive() }, [currentRow(1), currentRow(2, null)]);

    expect(assessment).toMatchObject({
      action: "quality_unavailable",
      canDeleteRaw: false,
      reasons: ["quality_not_rebuilt"],
      blockedBy: [],
    });
    expect(assessment.laps.map(({ lapId }) => lapId)).toEqual([1, 2]);
    expect(assessment.laps[0]?.current["normal-pace"].status).toBe("eligible");
    for (const decisions of [assessment.laps[1]?.current, assessment.laps[1]?.postRawRemoval]) {
      expect(Object.keys(decisions ?? {})).toEqual([...POLICY_IDS]);
      for (const policyId of POLICY_IDS) {
        const decision = decisions?.[policyId];
        expect(decision?.status).toBe("unknown");
        expect(decision?.reasons.map(({ code }) => code)).toContain("quality_not_rebuilt");
      }
    }
  });

  test("stale eligibility snapshots block raw deletion with a stale reason", () => {
    const staleRow = { ...currentRow(), qualityStale: true };
    const assessment = evaluateEvidenceRetention(236, { rawCapture: true, canonicalArchive: archive() }, [staleRow]);

    expect(assessment).toMatchObject({
      action: "quality_unavailable",
      canDeleteRaw: false,
      reasons: ["quality_stale"],
    });
    expect(assessment.laps[0]?.current["corner-trace"]).toMatchObject({
      status: "unknown",
      reasons: [expect.objectContaining({ code: "quality_stale" })],
    });
  });

  test("distinguishes verified empty archive from unavailable archive", () => {
    const verifiedEmpty = archive({ semanticIds: [], eventIds: [], details: "Verified archive contains no canonical channels" });
    const unavailable = archive({ state: "unavailable", semanticIds: [], eventIds: [], provenance: null, details: "No canonical archive inventory" });

    const verifiedAssessment = evaluateEvidenceRetention(236, { rawCapture: true, canonicalArchive: verifiedEmpty }, [currentRow()]);
    const unavailableAssessment = evaluateEvidenceRetention(236, { rawCapture: true, canonicalArchive: unavailable }, [currentRow()]);

    expect(verifiedAssessment.availability.canonicalArchive).toMatchObject({ state: "available", semanticIds: [], provenance: verifiedEmpty.provenance });
    expect(unavailableAssessment.availability.canonicalArchive).toMatchObject({ state: "unavailable", semanticIds: [], provenance: null });
  });
});
