import { parseIRacingSessionInfo, parseIRacingTrackGeography } from "@raceiq/capture-formats/iracing/session-info";
import type { IRacingSessionSnapshot, IRacingSourceFrame, IRacingValue } from "@raceiq/capture-formats/iracing/source-frame";
import type { ImportedTelemetrySource } from "@raceiq/backend-core/games/types";
import { IRacingIbtReader } from "./ibt-reader";
import { createIRacingParserState, normalizeIRacingFrame } from "./normalizer";
import { IbtImportError, previewIbtFile, TIMING_ROLLOVER_SECONDS, type IbtImportPreview } from "./ibt-preview";
export async function readIbtSource(
  path: string,
  suppliedPreview?: IbtImportPreview,
): Promise<ImportedTelemetrySource> {
  const preview = suppliedPreview ?? await previewIbtFile(path);
  if (!preview.canImport) throw new IbtImportError(preview.reason ?? "IBT recording cannot be imported");
  if (preview.firstDrivingRecord === null) throw new IbtImportError("IBT recording contains no importable driving window");
  const lastRecord = Math.min(
    preview.recordCount - 1,
    preview.lastDrivingRecord! + Math.ceil(preview.tickRate * TIMING_ROLLOVER_SECONDS),
  );
  const reader = new IRacingIbtReader(path);
  const parserState = createIRacingParserState();
  const sessions = new Map<number, IRacingSessionSnapshot>();
  const packets: ImportedTelemetrySource["packets"] = [];
  const nativeValues: Readonly<Record<string, unknown>>[] = [];
  let trackGeography: Readonly<Record<string, number>> | undefined;
  reader.start();
  try {
    while (true) {
      const snapshot = reader.readLatest();
      if (!snapshot) break;
      const recordIndex = reader.recordsRead - 1;
      if (recordIndex < preview.firstDrivingRecord) continue;
      if (recordIndex > lastRecord) break;
      const rawValues = snapshot.values as Record<string, IRacingValue>;
      const sessionNumValue = rawValues.SessionNum;
      const sessionNum = typeof sessionNumValue === "number" && Number.isFinite(sessionNumValue)
        ? Math.trunc(sessionNumValue)
        : 0;
      let session = sessions.get(sessionNum);
      if (!session) {
        session = parseIRacingSessionInfo(snapshot.sessionInfo, sessionNum);
        sessions.set(sessionNum, session);
      }
      const frame: IRacingSourceFrame = {
        schemaVersion: 3,
        session,
        values: rawValues,
        sessionInfo: snapshot.sessionInfo,
        sessionInfoUpdate: snapshot.sessionInfoUpdate,
      };
      packets.push(normalizeIRacingFrame(frame, parserState));
      trackGeography ??= parseIRacingTrackGeography(snapshot.sessionInfo);
      Object.assign(rawValues, trackGeography);
      // IRacingIbtReader allocates a fresh values record per row; enrich and retain it directly.
      nativeValues.push(rawValues);
    }
  } finally {
    await reader.stop();
  }
  return { packets, nativeValues };
}
