import { eq } from "drizzle-orm";

import type { GameId } from "../../shared/games/ids";
import type { SourceChannelProfile } from "../../shared/racing/quality/contracts";
import {
  activateAnalysisGeneration,
  beginAnalysisGeneration,
  bindAnalysisGenerationSource,
  failAnalysisGeneration,
  type AnalysisReceiptRow,
} from "../db/analysis-receipt-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { loadRawCaptureIdentity } from "../session-capture/identity";
import { currentAnalysisContract } from "./current-contract";
import { createPersistedSessionAnalysisReceipt } from "./receipt";

export async function beginSessionAnalysisAttempt(
  sessionId: number,
  gameId: GameId,
  sourceChannelProfile: SourceChannelProfile | null | undefined,
): Promise<AnalysisReceiptRow> {
  const contract = currentAnalysisContract(gameId, sourceChannelProfile ?? null);
  return beginAnalysisGeneration({
    sessionId,
    artifactSetType: "session_analysis",
    sourceContentHash: null,
    contractHash: contract.contractHash,
    configurationHash: contract.configurationHash,
  });
}

export async function activateSessionAnalysisAttempt(
  attempt: AnalysisReceiptRow,
  gameId: GameId,
): Promise<AnalysisReceiptRow> {
  try {
    const [session] = await db
      .select({ rawFile: sessions.rawFile })
      .from(sessions)
      .where(eq(sessions.id, attempt.sessionId))
      .limit(1);
    if (!session) throw new Error("Session not found");

    const raw = session.rawFile
      ? await loadRawCaptureIdentity(session.rawFile)
      : undefined;
    const boundAttempt = raw
      ? await bindAnalysisGenerationSource({
          generationId: attempt.generationId,
          sourceContentHash: raw.contentHash,
        })
      : attempt;
    const receipt = await createPersistedSessionAnalysisReceipt(boundAttempt, gameId);
    return await activateAnalysisGeneration({
      generationId: boundAttempt.generationId,
      receipt,
    });
  } catch (error) {
    await failAnalysisGeneration(attempt.generationId, {
      code: "output_verification_failed",
      message: "Session analysis receipt verification failed",
      failedAt: new Date().toISOString(),
      checks: [
        {
          id: "storage_state",
          status: "failed",
          details: "Session analysis receipt verification failed",
        },
      ],
    });
    throw error;
  }
}
