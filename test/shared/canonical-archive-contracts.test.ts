import { describe, expect, test } from "bun:test";

import { CanonicalArchiveAvailabilitySchema } from "../../shared/racing/archives/contracts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const EVENT_ID = `race-event:sha256:${"d".repeat(64)}`;

const fixtures = {
  available: {
    state: "available",
    status: "verified",
    completeness: "complete",
    archiveId: "canonical-archive:42",
    generationId: "analysis-generation:42",
    semanticIds: ["motion.speed"],
    eventIds: [EVENT_ID],
    provenance: {
      archiveIdentity: "canonical-archive:42",
      schemaIdentity: "analysis-receipt-v1",
      configIdentity: HASH_A,
      sourceIdentity: HASH_B,
      outputIdentity: HASH_C,
    },
    details: null,
  },
  unavailable: {
    state: "unavailable",
    status: null,
    completeness: null,
    archiveId: null,
    generationId: null,
    semanticIds: [],
    eventIds: [],
    provenance: null,
    details: "No verified active canonical archive receipt",
  },
  partial: {
    state: "unavailable",
    status: "partial",
    completeness: "partial",
    archiveId: "canonical-archive:42",
    generationId: "analysis-generation:42",
    semanticIds: ["motion.speed"],
    eventIds: [EVENT_ID],
    provenance: null,
    details: "Canonical archive is partial; raw capture must remain",
  },
  corrupt: {
    state: "unavailable",
    status: "failed",
    completeness: "unavailable",
    archiveId: null,
    generationId: null,
    semanticIds: [],
    eventIds: [],
    provenance: null,
    details: "Canonical archive durable output failed verification",
  },
  unknown: {
    state: "unknown",
    status: null,
    completeness: null,
    archiveId: null,
    generationId: null,
    semanticIds: [],
    eventIds: [],
    provenance: null,
    details: "Canonical archive state cannot be determined",
  },
} as const;

describe("canonical archive availability contract", () => {
  test.each(Object.entries(fixtures))("parses %s server fixture", (_name, fixture) => {
    const result = CanonicalArchiveAvailabilitySchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  test("rejects unknown semantic and race-event identifiers", () => {
    expect(CanonicalArchiveAvailabilitySchema.safeParse({
      ...fixtures.available,
      semanticIds: ["unknown.semantic-id"],
    }).success).toBe(false);
    expect(CanonicalArchiveAvailabilitySchema.safeParse({
      ...fixtures.available,
      eventIds: ["event-without-canonical-identity"],
    }).success).toBe(false);
  });

  test("requires nullable metadata and provenance keys in every state", () => {
    const { status: _status, ...missingStatus } = fixtures.unavailable;
    const { provenance: _provenance, ...missingProvenance } = fixtures.unavailable;
    expect(CanonicalArchiveAvailabilitySchema.safeParse(missingStatus).success).toBe(false);
    expect(CanonicalArchiveAvailabilitySchema.safeParse(missingProvenance).success).toBe(false);
  });
});
