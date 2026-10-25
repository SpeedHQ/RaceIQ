import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, ProcessingMetadata, SessionCaptureSplitPhase } from "@raceiq/shared/racing/sessions/types";

type StoredLapMetaRow = {
  processing: ProcessingMetadata;
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean | number;
  classification: LapMeta["classification"];
  invalidReason: string | null;
  notes: string | null;
  pi: number | null;
  carSetup: string | null;
  createdAt: string;
  carId: string;
  trackId: string;
  tuneId: number | null;
  tuneName: string | null;
  gameId: string;
  sectorTimes: number[] | null;
  source: string | null;
  experimentId: number | null;
  experimentVersionId: number | null;
  experimentExcluded: boolean | number | null;
  experimentExcludedSource: string | null;
  fuelPerLap: number | null;
  tyreWear: number | null;
  catalogVersion?: string | null;
  catalogHash?: string | null;
  catalogSchemaVersion?: string | null;
  parserVersion?: string | null;
  resolverVersion?: string | null;
  derivationVersion?: string | null;
  rawFrameCount?: number | null;
  rawByteOffset?: number | null;
  rawFile?: string | null;
  isFavorite?: boolean | number | null;
  telemetryAvailable?: boolean | number | null;
  ownership?: string | null;
  standaloneCaptureReady?: boolean | number | null;
  captureManifestFile?: string | null;
  capturePhase?: SessionCaptureSplitPhase | null;
};
export function mergeLapProcessingMetadata(
  capturePhase: SessionCaptureSplitPhase | null | undefined,
  indexProcessing: ProcessingMetadata,
): ProcessingMetadata {
  if (capturePhase === "failed") return { state: "failed", stage: "capture", error: "Capture preparation failed" };
  if (capturePhase === "queued") return { state: "queued", stage: "capture", error: null };
  if (capturePhase === "splitting" || capturePhase === "verifying" || capturePhase === "publishing") {
    return { state: "processing", stage: "capture", error: null };
  }
  return indexProcessing;
}

/** Normalize nullable SQLite fields into the public LapMeta representation. */
export function toLapMeta(row: StoredLapMetaRow): LapMeta {
  const {
    isValid,
    classification,
    invalidReason,
    notes,
    pi,
    carSetup,
    tuneId,
    carId,
    trackId,
    tuneName,
    gameId,
    sectorTimes,
    source,
    experimentId,
    experimentVersionId,
    experimentExcluded,
    experimentExcludedSource,
    fuelPerLap,
    tyreWear,
    catalogVersion,
    catalogHash,
    catalogSchemaVersion,
    parserVersion,
    resolverVersion,
    derivationVersion,
    ownership,
    rawFrameCount,
    rawByteOffset,
    rawFile: _rawFile,
    captureManifestFile: _captureManifestFile,
    capturePhase: _capturePhase,
    isFavorite,
    telemetryAvailable,
    standaloneCaptureReady,
    processing,
    ...base
  } = row;

  const versionIdentity = "catalogVersion" in row
    ? {
        catalogVersion: catalogVersion ?? undefined,
        catalogHash: catalogHash ?? undefined,
        catalogSchemaVersion: catalogSchemaVersion ?? undefined,
        parserVersion: parserVersion ?? undefined,
        resolverVersion: resolverVersion ?? undefined,
        derivationVersion: derivationVersion ?? undefined,
      }
    : {};
  const frameCount = "rawFrameCount" in row
    ? { rawFrameCount: rawFrameCount ?? null }
    : {};
  const lapTelemetryAvailable = telemetryAvailable !== undefined
    ? Boolean(telemetryAvailable)
    : _rawFile !== undefined
      ? _rawFile !== null && rawByteOffset != null && (rawFrameCount ?? 0) > 0
      : undefined;

  return {
    ...base,
    processing,
    carId,
    trackId,
    ...versionIdentity,
    ...frameCount,
    isValid: Boolean(isValid),
    classification: classification ?? null,
    invalidReason: invalidReason ?? undefined,
    notes: notes ?? undefined,
    pi: pi ?? 0,
    carSetup: carSetup ?? undefined,
    tuneId: tuneId ?? undefined,
    tuneName: tuneName ?? undefined,
    gameId: gameId as GameId,
    sectorTimes: sectorTimes ?? undefined,
    source: source === "motec" || source === "ibt" ? source : null,
    ownership: ownership === "others" ? "others" : "mine",
    experimentId: experimentId ?? null,
    experimentVersionId: experimentVersionId ?? null,
    experimentExcluded: Boolean(experimentExcluded),
    // Manual provenance must travel with the flag or review selection can
    // incorrectly rank an excluded lap back into the fastest-N pool.
    experimentExcludedSource:
      (experimentExcludedSource as "auto" | "manual" | null) ?? null,
    fuelPerLap: fuelPerLap ?? null,
    tyreWear: tyreWear ?? null,
    isFavorite: Boolean(isFavorite),
    telemetryAvailable: lapTelemetryAvailable,
    standaloneCaptureReady: standaloneCaptureReady === undefined ? undefined : Boolean(standaloneCaptureReady),
  };
}
