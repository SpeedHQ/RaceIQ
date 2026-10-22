import { waitForSourcePrefix } from "@raceiq/capture-formats/session/source-writer-worker";
import { parentPort, workerData } from "node:worker_threads";
import { Schema } from "effect";
import { GameId, registerLiveSplitterWorker } from "@raceiq/capture-splitting";
import type { LiveParserPlan, LapWindow, LiveParserReplayEvidence, StreamingMemberStage } from "@raceiq/capture-splitting";
import { createLiveGameParserCodec, LiveParserEvidenceTracker, replayLiveParserStage } from "./live-game-codecs";
import { LiveCanonicalSourceReader } from "./live-source-reader";

if (!parentPort) throw new Error("Live capture worker requires worker thread");
const port = parentPort;
const data = workerData as { gameId?: unknown } | undefined;
const gameId = Schema.decodeUnknownSync(GameId)(data?.gameId);
const codec = createLiveGameParserCodec(gameId);
const parserEvidence = new LiveParserEvidenceTracker(gameId, codec);
let canonicalReader: LiveCanonicalSourceReader | null = null;
let canonicalReaderPath: string | null = null;
let canonicalSourceIdentity: Awaited<ReturnType<typeof waitForSourcePrefix>> | null = null;

registerLiveSplitterWorker(port, {
  async waitForSourcePrefix(sourceByteOffset) { canonicalSourceIdentity = await waitForSourcePrefix(sourceByteOffset); },
  async readCanonicalBatch(sourcePath, startOffset, endOffset, maxBytes, maxRecords) {
    const identity = canonicalSourceIdentity;
    if (!identity || identity.sourcePath !== sourcePath) throw new Error("Canonical catch-up source does not match writer identity");
    if (!canonicalReader || canonicalReaderPath !== sourcePath) {
      await canonicalReader?.close();
      canonicalReader = new LiveCanonicalSourceReader(sourcePath, { device: identity.fileDev, inode: identity.fileIno });
      canonicalReaderPath = sourcePath;
    }
    return canonicalReader.readBatch(startOffset, endOffset, maxBytes, maxRecords);
  },
  async closeSourceReader() {
    await canonicalReader?.close();
    canonicalReader = null;
    canonicalReaderPath = null;
  },
  gameId,
  sourceRecord(record) {
    parserEvidence.sourceRecord(record);
  },
  candidateStart(
    candidateId: string,
    _lapNumber: number,
    startByteOffset: number,
    plan: LiveParserPlan,
    preparationOnly: boolean,
  ) {
    return parserEvidence.candidateStart(candidateId, startByteOffset, plan, preparationOnly);
  },
  promoteCandidate(candidateId: string) {
    parserEvidence.promoteCandidate(candidateId);
  },
  discardCandidate(candidateId: string) {
    parserEvidence.discardCandidate(candidateId);
  },
  finalizeWindow(lap: LapWindow) {
    parserEvidence.finalizeWindow(lap);
  },
  replayEvidence(lap: LapWindow): LiveParserReplayEvidence | undefined {
    return parserEvidence.takeReplayEvidence(lap);
  },
  async replayParser(
    stage: StreamingMemberStage,
    lap: LapWindow,
    evidence?: LiveParserReplayEvidence,
  ): Promise<void> {
    if (!evidence) throw new Error(`Missing source parser evidence for lap ${lap.lapId}`);
    await replayLiveParserStage(gameId, stage, lap, codec, evidence);
  },
});
