import type {
  CanonicalJson,
  FindingEvidenceRef,
  FindingRecord,
  FindingScope,
} from "./types";

export interface FindingIdentityCoordinates {
  type: string;
  scope: FindingScope;
  evidenceRefs: FindingEvidenceRef[];
  analysisGenerationId: string;
  ruleVersion: string;
  comparisonReferenceId?: string;
}

export interface FindingConflict {
  id: string;
  firstIndex: number;
  conflictingIndex: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Normalises JSON objects to sorted keys and rejects lossy JSON values. */
export function canonicalize(value: unknown): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const result: CanonicalJson[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new TypeError("Canonical JSON arrays cannot contain holes or undefined");
      }
      const entry = value[index];
      if (entry === undefined) {
        throw new TypeError("Canonical JSON arrays cannot contain holes or undefined");
      }
      result.push(canonicalize(entry));
    }
    return result;
  }
  if (!isPlainObject(value)) throw new TypeError("Canonical JSON accepts only JSON objects and arrays");

  const result: Record<string, CanonicalJson> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) throw new TypeError(`Canonical JSON property ${key} is undefined`);
    result[key] = canonicalize(entry);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sortCanonical<T>(values: readonly T[]): CanonicalJson[] {
  return values
    .map((value) => canonicalize(value))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function definedScopeIds(scope: FindingScope): Record<string, string> {
  const coordinates: Record<string, string> = {
    kind: scope.kind,
    sessionId: scope.sessionId,
  };
  if (scope.gameId !== undefined) coordinates.gameId = scope.gameId;
  for (const key of [
    "participantId",
    "stintId",
    "paceSegmentId",
    "lapId",
    "cornerId",
    "segmentId",
  ] as const) {
    const value = scope[key];
    if (value !== undefined) coordinates[key] = value;
  }
  return coordinates;
}

export function findingIdentityCoordinates(
  input: FindingIdentityCoordinates | FindingRecord,
): FindingIdentityCoordinates {
  if ("status" in input) {
    return {
      type: input.type,
      scope: input.scope,
      evidenceRefs: input.evidenceRefs,
      analysisGenerationId: input.analysisGenerationId,
      ruleVersion: input.rule.version,
      comparisonReferenceId: input.comparisonReference?.id,
    };
  }
  return input;
}

function identityPayload(input: FindingIdentityCoordinates | FindingRecord): CanonicalJson {
  const coordinates = findingIdentityCoordinates(input);
  return canonicalize({
    schema: "finding-identity-v1",
    type: coordinates.type,
    scope: definedScopeIds(coordinates.scope),
    evidence: coordinates.evidenceRefs
      .map((reference) => ({ kind: reference.kind, id: reference.id }))
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)),
    comparisonReferenceId: coordinates.comparisonReferenceId ?? null,
    analysisGenerationId: coordinates.analysisGenerationId,
    ruleVersion: coordinates.ruleVersion,
  });
}

/** Browser-safe FNV-1a 64-bit digest. Identity stability matters more than secrecy. */
function stableDigest(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function createFindingId(input: FindingIdentityCoordinates | FindingRecord): string {
  return `finding-v1-${stableDigest(canonicalJson(identityPayload(input)))}`;
}

function normaliseEvidence(reference: FindingEvidenceRef): CanonicalJson {
  const object = canonicalize(reference) as Record<string, CanonicalJson>;
  if (Array.isArray(object.semanticIds)) {
    object.semanticIds = [...object.semanticIds].sort((left, right) =>
      String(left).localeCompare(String(right))
    );
  }
  return object;
}

/** Material content excludes convenience prose and order of set-like collections. */
function materialRecord(record: FindingRecord): CanonicalJson {
  const { title: _title, ...structured } = record;
  const limitations = record.limitations.map((limitation) => {
    if (!limitation.evidenceRefs) return limitation;
    return {
      ...limitation,
      evidenceRefs: limitation.evidenceRefs.map(normaliseEvidence).sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
    };
  });
  return canonicalize({
    ...structured,
    measurements: sortCanonical(record.measurements.map((measurement) => ({
      ...measurement,
      semanticIds: [...measurement.semanticIds].sort(),
    }))),
    evidenceRefs: record.evidenceRefs.map(normaliseEvidence).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
    qualityRefs: record.qualityRefs.map(normaliseEvidence).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
    limitations: sortCanonical(limitations),
    ...(record.comparisonReference
      ? {
          comparisonReference: {
            ...record.comparisonReference,
            evidenceRefs: record.comparisonReference.evidenceRefs
              .map(normaliseEvidence)
              .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
          },
        }
      : {}),
  });
}

export function findFindingConflicts(records: readonly FindingRecord[]): FindingConflict[] {
  const seen = new Map<string, { index: number; material: string }>();
  const conflicts: FindingConflict[] = [];
  records.forEach((record, index) => {
    const material = canonicalJson(materialRecord(record));
    const previous = seen.get(record.id);
    if (!previous) {
      seen.set(record.id, { index, material });
    } else if (previous.material !== material) {
      conflicts.push({ id: record.id, firstIndex: previous.index, conflictingIndex: index });
    }
  });
  return conflicts;
}

export function assertNoFindingConflicts(records: readonly FindingRecord[]): void {
  const conflicts = findFindingConflicts(records);
  if (conflicts.length === 0) return;
  const summary = conflicts
    .map((conflict) => `${conflict.id} at indices ${conflict.firstIndex}/${conflict.conflictingIndex}`)
    .join(", ");
  throw new Error(`Conflicting finding records share an ID: ${summary}`);
}
