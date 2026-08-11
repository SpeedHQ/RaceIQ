import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createGunzip } from "node:zlib";
import { z } from "zod";

export const GOLDEN_MANIFEST_SCHEMA_VERSION = 1 as const;

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoTimestampSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "Expected an ISO timestamp",
);
const IdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const EvidenceKindSchema = z.enum([
  "source_observed",
  "machine_derived",
  "driver_reported",
]);

const ArtifactSchema = z
  .object({
    path: z.string().min(1),
    format: z.literal("raceiq-session-capture"),
    format_version: PositiveIntegerSchema,
    compression: z.literal("gzip"),
    byte_length: PositiveIntegerSchema,
    sha256: Sha256Schema,
    uncompressed_byte_length: PositiveIntegerSchema,
    uncompressed_sha256: Sha256Schema,
    record_count: PositiveIntegerSchema,
    started_at: IsoTimestampSchema,
    ended_at: IsoTimestampSchema,
    duration_ms: PositiveIntegerSchema,
  })
  .strict();

const SimulatorSchema = z
  .object({
    game_id: z.enum(["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"]),
    name: z.string().min(1),
    version: z.string().nullable(),
    shared_memory_version: z.string().nullable(),
    source_adapter: z.string().min(1),
  })
  .strict();

const VehicleSchema = z
  .object({
    car: z.string().min(1),
    source_model: z.string().min(1),
    class: z.string().min(1),
    catalog_ordinal: NonNegativeIntegerSchema,
  })
  .strict();

const CircuitSchema = z
  .object({
    track: z.string().min(1),
    layout: z.string().min(1),
    source_name: z.string().min(1),
    catalog_ordinal: NonNegativeIntegerSchema,
  })
  .strict();

const ConditionsSchema = z
  .object({
    session_type: z.string().min(1),
    weather: z.enum(["dry", "wet", "mixed", "unknown"]),
    track_condition: z.enum(["dry", "wet", "mixed", "unknown"]),
    time_of_day: z.enum(["day", "night", "mixed", "unknown"]),
    traffic: z.enum(["none", "minimal", "present", "unknown"]),
    participant_count: PositiveIntegerSchema.nullable(),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();

const PurposeSchema = z.enum([
  "canonical_telemetry_reference",
  "parser_regression",
  "live_replay_parity",
  "archive_rebuild_parity",
  "lap_analysis",
  "stint_analysis",
  "tire_degradation_analysis",
  "fuel_consumption_analysis",
  "pit_transition_analysis",
  "pit_service_analysis",
  "damage_analysis",
  "assist_analysis",
  "abnormal_event_analysis",
]);

const ProtocolStintSchema = z
  .object({
    id: IdSchema,
    role: z.enum(["clean_reference", "varied_eventful"]),
    approximate_laps: PositiveIntegerSchema,
    intent: z.string().min(1),
  })
  .strict();

const ProtocolSchema = z
  .object({
    stints: z.array(ProtocolStintSchema).length(2),
    transition: z
      .object({
        intent: z.enum(["normal_pit_service", "return_to_garage_reset"]),
        tires_expected: z.enum(["changed", "unchanged", "not_required"]),
        fuel_expected: z.enum(["added", "unchanged", "not_required"]),
      })
      .strict(),
    finish_intent: z.string().min(1),
  })
  .strict();

const CompletedLapsSchema = z
  .object({
    value: NonNegativeIntegerSchema,
    basis: EvidenceKindSchema,
    source_counter_start: NonNegativeIntegerSchema,
    source_counter_end: NonNegativeIntegerSchema,
  })
  .strict();

const RaceIqLapRowsSchema = z
  .object({
    complete: NonNegativeIntegerSchema,
    incomplete: NonNegativeIntegerSchema,
    matched_source_completions: NonNegativeIntegerSchema,
  })
  .strict();

const ObservedStintSchema = z
  .object({
    id: IdSchema,
    assessment: z.enum([
      "generally_clean",
      "mixed",
      "intentionally_varied",
      "incomplete",
    ]),
    source_completed_lap_range: z
      .tuple([PositiveIntegerSchema, PositiveIntegerSchema])
      .nullable(),
    notes: z.array(z.string().min(1)),
  })
  .strict();

const ObservedTransitionSchema = z
  .object({
    kind: z.enum([
      "normal_pit_service",
      "pit_entry_then_return_to_garage",
      "none",
    ]),
    source_current_lap: PositiveIntegerSchema.nullable(),
    tires_changed: z.enum(["yes", "no", "unknown"]),
    fuel_added: z.enum(["yes", "no", "unknown"]),
    service_observed: z.boolean(),
    notes: z.array(z.string().min(1)),
  })
  .strict();

const LapAlignmentSchema = z
  .object({
    source_completed_lap: PositiveIntegerSchema,
    source_lap_time_seconds: z.number().positive(),
    raceiq_lap_row: PositiveIntegerSchema.nullable(),
    coverage: z.enum(["full", "partial", "missing"]),
    note: z.string().min(1).optional(),
  })
  .strict();

const UnmatchedLapRowSchema = z
  .object({
    raceiq_lap_row: PositiveIntegerSchema,
    phase: z.enum(["flying", "out", "in", "pit", "grid_start", "unknown"]),
    lap_time_seconds: z.number().positive(),
    interpretation: z.string().min(1),
  })
  .strict();

const LapReferenceSchema = z
  .object({
    driver_reported_lap: PositiveIntegerSchema.optional(),
    source_current_lap: PositiveIntegerSchema.optional(),
    source_completed_lap: PositiveIntegerSchema.optional(),
    raceiq_lap_row: PositiveIntegerSchema.optional(),
    note: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.driver_reported_lap !== undefined ||
      value.source_current_lap !== undefined ||
      value.source_completed_lap !== undefined ||
      value.raceiq_lap_row !== undefined,
    "At least one lap reference is required",
  );

const EventEvidenceSchema = z
  .object({
    kind: EvidenceKindSchema,
    detail: z.string().min(1),
  })
  .strict();

const ObservedEventSchema = z
  .object({
    id: IdSchema,
    type: z.enum([
      "spin",
      "off_track",
      "damage",
      "pit_entry",
      "return_to_garage",
      "assist_change",
      "wheel_lock",
      "wheelspin",
      "session_end",
    ]),
    stint_id: IdSchema.nullable(),
    approximate_corner: z.string().min(1).nullable(),
    lap_reference: LapReferenceSchema.nullable(),
    evidence: z.array(EventEvidenceSchema).min(1),
  })
  .strict();

const KnownIssueSchema = z
  .object({
    type: z.enum([
      "telemetry_gap",
      "missing_lap_telemetry",
      "partial_lap_telemetry",
      "protocol_deviation",
      "source_limitation",
    ]),
    severity: z.enum(["info", "warning", "degraded"]),
    evidence_kind: EvidenceKindSchema,
    description: z.string().min(1),
    duration_ms: PositiveIntegerSchema.optional(),
    missing_records: PositiveIntegerSchema.optional(),
    missing_fraction: z.number().min(0).max(1).optional(),
    affected_source_laps: z.array(PositiveIntegerSchema).optional(),
  })
  .strict();

const CapabilityLimitationSchema = z
  .object({
    capability: IdSchema,
    state: z.enum(["unavailable", "unpopulated", "inferred", "limited"]),
    description: z.string().min(1),
  })
  .strict();

const ValidationRoleSchema = z
  .object({
    role: z.enum([
      "clean_baseline",
      "parser_regression",
      "live_replay_parity",
      "archive_rebuild_parity",
      "lap_analysis",
      "stint_analysis",
      "tire_degradation_analysis",
      "fuel_consumption_analysis",
      "pit_transition",
      "pit_service",
      "damage_analysis",
      "assist_analysis",
      "abnormal_event_analysis",
      "opponent_analysis",
      "caution_analysis",
    ]),
    enabled: z.boolean(),
    scope: z.string().min(1).optional(),
    limitation: z.string().min(1).optional(),
  })
  .strict();

const ProvenanceSchema = z
  .object({
    parser_version: z.string().min(1),
    lap_detector_version: z.string().min(1),
    catalog_version: z.string().min(1),
    catalog_hash: Sha256Schema,
    catalog_schema_version: z.string().min(1),
    resolver_version: z.string().min(1),
    derivation_version: z.string().min(1),
    quality_schema_version: z.string().min(1),
    quality_policy_version: z.string().min(1),
    quality_config_version: z.string().min(1),
  })
  .strict();

const AcceptanceSchema = z
  .object({
    accepted_at: IsoTimestampSchema,
    accepted_by: z.string().min(1),
    immutable_source: z.literal(true),
    basis: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const GoldenRecordingManifestSchema = z
  .object({
    manifest_schema_version: z.literal(GOLDEN_MANIFEST_SCHEMA_VERSION),
    id: IdSchema,
    recording_version: PositiveIntegerSchema,
    status: z.enum(["candidate", "reviewed", "accepted", "superseded", "rejected"]),
    artifact: ArtifactSchema,
    simulator: SimulatorSchema,
    vehicle: VehicleSchema,
    circuit: CircuitSchema,
    purpose: z.array(PurposeSchema).min(1),
    conditions: ConditionsSchema,
    protocol: ProtocolSchema,
    observations: z
      .object({
        actual_completed_laps: CompletedLapsSchema,
        raceiq_lap_rows: RaceIqLapRowsSchema,
        stints: z.array(ObservedStintSchema).length(2),
        transition: ObservedTransitionSchema,
        lap_alignment: z.array(LapAlignmentSchema).min(1),
        unmatched_raceiq_rows: z.array(UnmatchedLapRowSchema),
        events: z.array(ObservedEventSchema),
        known_recording_issues: z.array(KnownIssueSchema),
        recording_quality: z.enum(["clean", "accepted_with_known_limitations", "degraded"]),
      })
      .strict(),
    capability_limitations: z.array(CapabilityLimitationSchema),
    validation_roles: z.array(ValidationRoleSchema).min(1),
    provenance: ProvenanceSchema,
    acceptance: AcceptanceSchema.nullable(),
    notes: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (!manifest.id.endsWith(`-v${manifest.recording_version}`)) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "ID version suffix must match recording_version",
      });
    }

    if (manifest.status === "accepted" && manifest.acceptance === null) {
      context.addIssue({
        code: "custom",
        path: ["acceptance"],
        message: "Accepted recordings require acceptance metadata",
      });
    }

    const protocolStintIds = manifest.protocol.stints.map((stint) => stint.id);
    if (new Set(protocolStintIds).size !== protocolStintIds.length) {
      context.addIssue({
        code: "custom",
        path: ["protocol", "stints"],
        message: "Protocol stint IDs must be unique",
      });
    }

    const roles = new Set(manifest.protocol.stints.map((stint) => stint.role));
    if (!roles.has("clean_reference") || !roles.has("varied_eventful")) {
      context.addIssue({
        code: "custom",
        path: ["protocol", "stints"],
        message: "Protocol requires clean_reference and varied_eventful stints",
      });
    }

    const observedStintIds = manifest.observations.stints.map((stint) => stint.id);
    if (
      observedStintIds.length !== protocolStintIds.length ||
      observedStintIds.some((id) => !protocolStintIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["observations", "stints"],
        message: "Observed stints must match protocol stint IDs",
      });
    }

    for (const [index, event] of manifest.observations.events.entries()) {
      if (event.stint_id !== null && !protocolStintIds.includes(event.stint_id)) {
        context.addIssue({
          code: "custom",
          path: ["observations", "events", index, "stint_id"],
          message: "Event references an unknown stint",
        });
      }
    }

    const alignmentLaps = manifest.observations.lap_alignment.map(
      (alignment) => alignment.source_completed_lap,
    );
    if (new Set(alignmentLaps).size !== alignmentLaps.length) {
      context.addIssue({
        code: "custom",
        path: ["observations", "lap_alignment"],
        message: "Source completed laps must be unique",
      });
    }

    const validationRoles = manifest.validation_roles.map((role) => role.role);
    if (new Set(validationRoles).size !== validationRoles.length) {
      context.addIssue({
        code: "custom",
        path: ["validation_roles"],
        message: "Validation roles must be unique",
      });
    }
  });

export type GoldenRecordingManifest = z.infer<
  typeof GoldenRecordingManifestSchema
>;

export interface GoldenArtifactVerification {
  artifactPath: string;
  artifactBytes: number;
  artifactSha256: string;
  uncompressedBytes: number;
  uncompressedSha256: string;
}

function formatSchemaError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
    .join("\n");
}

export function parseGoldenRecordingManifest(
  input: unknown,
): GoldenRecordingManifest {
  const result = GoldenRecordingManifestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatSchemaError(result.error));
  }
  return result.data;
}

export function readGoldenRecordingManifest(
  manifestPath: string,
): GoldenRecordingManifest {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${manifestPath}: invalid JSON: ${message}`);
  }
  try {
    return parseGoldenRecordingManifest(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${manifestPath}: ${message}`);
  }
}

async function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { bytes, sha256: `sha256:${hash.digest("hex")}` };
}

async function sha256GzipPayload(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.length;
      callback();
    },
  });
  await pipeline(createReadStream(path), createGunzip(), sink);
  return { bytes, sha256: `sha256:${hash.digest("hex")}` };
}

export async function verifyGoldenRecordingArtifact(
  manifest: GoldenRecordingManifest,
  rootDir: string,
): Promise<GoldenArtifactVerification> {
  const artifactPath = resolve(rootDir, manifest.artifact.path);
  const rootRelativePath = relative(resolve(rootDir), artifactPath);
  if (
    rootRelativePath === "" ||
    rootRelativePath.startsWith("..") ||
    rootRelativePath.startsWith("/") ||
    rootRelativePath.startsWith("\\")
  ) {
    throw new Error(`${manifest.id}: artifact path must remain inside repository root`);
  }
  if (!existsSync(artifactPath)) {
    throw new Error(`${manifest.id}: artifact does not exist: ${manifest.artifact.path}`);
  }

  const artifact = await sha256File(artifactPath);
  if (artifact.bytes !== manifest.artifact.byte_length) {
    throw new Error(
      `${manifest.id}: artifact byte length mismatch: expected ${manifest.artifact.byte_length}, got ${artifact.bytes}`,
    );
  }
  if (artifact.sha256 !== manifest.artifact.sha256) {
    throw new Error(
      `${manifest.id}: artifact SHA-256 mismatch: expected ${manifest.artifact.sha256}, got ${artifact.sha256}`,
    );
  }

  const source = await sha256GzipPayload(artifactPath);
  if (source.bytes !== manifest.artifact.uncompressed_byte_length) {
    throw new Error(
      `${manifest.id}: uncompressed byte length mismatch: expected ${manifest.artifact.uncompressed_byte_length}, got ${source.bytes}`,
    );
  }
  if (source.sha256 !== manifest.artifact.uncompressed_sha256) {
    throw new Error(
      `${manifest.id}: uncompressed SHA-256 mismatch: expected ${manifest.artifact.uncompressed_sha256}, got ${source.sha256}`,
    );
  }

  return {
    artifactPath,
    artifactBytes: artifact.bytes,
    artifactSha256: artifact.sha256,
    uncompressedBytes: source.bytes,
    uncompressedSha256: source.sha256,
  };
}

export async function validateGoldenRecordingDirectory(
  manifestDir: string,
  rootDir: string,
): Promise<Array<{ manifest: GoldenRecordingManifest; verification: GoldenArtifactVerification }>> {
  const manifestPaths = readdirSync(manifestDir)
    .filter((filename) => filename.endsWith(".golden.json"))
    .sort()
    .map((filename) => resolve(manifestDir, filename));
  if (manifestPaths.length === 0) {
    throw new Error(`No golden recording manifests found in ${manifestDir}`);
  }

  const manifests = manifestPaths.map(readGoldenRecordingManifest);
  const ids = new Set<string>();
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) {
      throw new Error(`Duplicate golden recording ID: ${manifest.id}`);
    }
    ids.add(manifest.id);
  }

  const validated = [];
  for (const manifest of manifests) {
    validated.push({
      manifest,
      verification: await verifyGoldenRecordingArtifact(manifest, rootDir),
    });
  }
  return validated;
}
