import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, renameSync } from "node:fs";

import { renderTrackRegistryReport } from "./report";
import {
  TRACK_REGISTRY_SOURCE_VERSION,
  readFile,
  removeIfExists,
  renderTrackRegistrySource,
  resolveTrackRegistryLocations,
  sha256OverSourceFiles,
  validateTrackConfigurationSource,
  writeFile,
  type TrackConfigurationSource,
  type TrackFactsSource,
  type TrackGeometrySource,
  type TrackRegistryLocationsInput,
  type TrackRegistrySource,
  type VerifiedLedger,
} from "./source";

/** Generated in-memory track registry read-model version. */
export const TRACK_REGISTRY_VERSION = 1 as const;

/** Compact generated read model loaded by runtime consumers. */
export interface TrackRegistryReadModel {
  version: typeof TRACK_REGISTRY_VERSION;
  sourceVersion: typeof TRACK_REGISTRY_SOURCE_VERSION;
  sourceHash: string;
  venues: TrackConfigurationSource["venues"];
  layouts: TrackConfigurationSource["layouts"];
  assignments: TrackConfigurationSource["assignments"];
  facts: TrackFactsSource["facts"];
  geometry: TrackGeometrySource["geometry"];
  verification: VerifiedLedger;
}

function readModelSource(model: TrackRegistryReadModel): TrackRegistrySource {
  return {
    configurations: {
      version: model.sourceVersion,
      venues: model.venues,
      layouts: model.layouts,
      assignments: model.assignments,
    },
    facts: {
      version: model.sourceVersion,
      facts: model.facts,
    },
    geometry: {
      version: model.sourceVersion,
      geometry: model.geometry,
    },
    verification: {
      version: model.sourceVersion,
      entries: model.verification,
    },
  };
}

/** Build deterministic read model from validated authored source. */
export function compileTrackRegistryReadModel(source: TrackRegistrySource): TrackRegistryReadModel {
  const canonical = validateTrackConfigurationSource(source);
  return {
    version: TRACK_REGISTRY_VERSION,
    sourceVersion: TRACK_REGISTRY_SOURCE_VERSION,
    sourceHash: sha256OverSourceFiles(renderTrackRegistrySource(canonical)),
    venues: canonical.configurations.venues,
    layouts: canonical.configurations.layouts,
    assignments: canonical.configurations.assignments,
    facts: canonical.facts.facts,
    geometry: canonical.geometry.geometry,
    verification: canonical.verification.entries,
  };
}

/** Render byte-stable compact JSON runtime artifact. */
export function renderTrackRegistryReadModel(model: TrackRegistryReadModel): string {
  return `${JSON.stringify(model)}\n`;
}

/** Parse and deeply validate generated read model. */
export function parseTrackRegistryReadModel(contents: string, path = "track registry"): TrackRegistryReadModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Malformed generated track registry ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid generated track registry ${path}`);
  }

  const candidate = parsed as Partial<TrackRegistryReadModel>;
  if (candidate.version !== TRACK_REGISTRY_VERSION) {
    throw new Error(`Unsupported track registry version ${String(candidate.version)}; expected ${TRACK_REGISTRY_VERSION}`);
  }
  if (candidate.sourceVersion !== TRACK_REGISTRY_SOURCE_VERSION || typeof candidate.sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(candidate.sourceHash)) {
    throw new Error(`Invalid generated track registry metadata ${path}`);
  }
  if (
    !Array.isArray(candidate.venues) ||
    !Array.isArray(candidate.layouts) ||
    !Array.isArray(candidate.assignments) ||
    !Array.isArray(candidate.facts) ||
    !Array.isArray(candidate.geometry) ||
    !candidate.verification ||
    typeof candidate.verification !== "object" ||
    Array.isArray(candidate.verification)
  ) {
    throw new Error(`Invalid generated track registry records ${path}`);
  }

  let canonical: TrackRegistrySource;
  try {
    canonical = validateTrackConfigurationSource(readModelSource(candidate as TrackRegistryReadModel));
  } catch (error) {
    throw new Error(`Invalid generated track registry ${path}`, { cause: error });
  }
  const normalized: TrackRegistryReadModel = {
    version: TRACK_REGISTRY_VERSION,
    sourceVersion: TRACK_REGISTRY_SOURCE_VERSION,
    sourceHash: candidate.sourceHash,
    venues: canonical.configurations.venues,
    layouts: canonical.configurations.layouts,
    assignments: canonical.configurations.assignments,
    facts: canonical.facts.facts,
    geometry: canonical.geometry.geometry,
    verification: canonical.verification.entries,
  };
  if (renderTrackRegistryReadModel(normalized) !== renderTrackRegistryReadModel(candidate as TrackRegistryReadModel)) {
    throw new Error(`Non-canonical generated track registry ${path}`);
  }
  return normalized;
}

/** Read and validate generated JSON registry. */
export function readTrackRegistryReadModel(registryPath: string): TrackRegistryReadModel {
  if (!existsSync(registryPath)) throw new Error(`Missing generated track registry ${registryPath}`);
  return parseTrackRegistryReadModel(readFile(registryPath), registryPath);
}

/** Build source-bound JSON read model and audit report with rollback-safe replacement. */
export function buildTrackRegistryArtifacts(
  source: TrackRegistrySource,
  locations: TrackRegistryLocationsInput = {},
): { sourceHash: string; registry: TrackRegistryReadModel; report: string } {
  const resolved = resolveTrackRegistryLocations(locations);
  const registry = compileTrackRegistryReadModel(source);
  const report = renderTrackRegistryReport(registry);
  const nonce = randomBytes(8).toString("hex");
  const stagedRegistry = `${resolved.registryPath}.build.${nonce}.tmp`;
  const stagedReport = `${resolved.reportPath}.build.${nonce}.tmp`;
  const registryBackup = `${resolved.registryPath}.build.${nonce}.backup`;
  const reportBackup = `${resolved.reportPath}.build.${nonce}.backup`;

  writeFile(stagedRegistry, renderTrackRegistryReadModel(registry));
  writeFile(stagedReport, report);
  try {
    if (existsSync(resolved.registryPath)) copyFileSync(resolved.registryPath, registryBackup);
    if (existsSync(resolved.reportPath)) copyFileSync(resolved.reportPath, reportBackup);
    try {
      removeIfExists(resolved.registryPath);
      removeIfExists(resolved.reportPath);
      renameSync(stagedRegistry, resolved.registryPath);
      renameSync(stagedReport, resolved.reportPath);
    } catch (error) {
      if (existsSync(registryBackup)) copyFileSync(registryBackup, resolved.registryPath);
      else removeIfExists(resolved.registryPath);
      if (existsSync(reportBackup)) copyFileSync(reportBackup, resolved.reportPath);
      else removeIfExists(resolved.reportPath);
      throw error;
    }
    return { sourceHash: registry.sourceHash, registry, report };
  } finally {
    removeIfExists(stagedRegistry);
    removeIfExists(stagedReport);
    removeIfExists(registryBackup);
    removeIfExists(reportBackup);
  }
}
