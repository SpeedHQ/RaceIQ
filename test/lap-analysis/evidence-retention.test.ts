import { describe, expect, test } from "bun:test";
import type { EligibilityDecisionSet, EligibilityPolicyId } from "../../shared/racing/quality/contracts";
import { ELIGIBILITY_POLICY_VERSION } from "../../shared/racing/quality/contracts";
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

function archive(overrides: Partial<CanonicalArchiveAvailability> = {}): CanonicalArchiveAvailability {
  return {
    state: "available",
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
      const assessment = evaluateEvidenceRetention(236, entry.availability, [{ id: 1, eligibility: eligibility() }]);

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

  test("distinguishes verified empty archive from unavailable archive", () => {
    const verifiedEmpty = archive({ semanticIds: [], eventIds: [], details: "Verified archive contains no canonical channels" });
    const unavailable = archive({ state: "unavailable", semanticIds: [], eventIds: [], provenance: null, details: "No canonical archive inventory" });

    const verifiedAssessment = evaluateEvidenceRetention(236, { rawCapture: true, canonicalArchive: verifiedEmpty }, [{ id: 1, eligibility: eligibility() }]);
    const unavailableAssessment = evaluateEvidenceRetention(236, { rawCapture: true, canonicalArchive: unavailable }, [{ id: 1, eligibility: eligibility() }]);

    expect(verifiedAssessment.availability.canonicalArchive).toMatchObject({ state: "available", semanticIds: [], provenance: verifiedEmpty.provenance });
    expect(unavailableAssessment.availability.canonicalArchive).toMatchObject({ state: "unavailable", semanticIds: [], provenance: null });
  });
});
