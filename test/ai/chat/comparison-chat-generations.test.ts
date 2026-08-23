import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { compareChatThreadId, getChatMemory, saveChatMessages } from "../../../server/ai/chat-agent";
import { compareFindingGenerationCacheKey, getCompareQualityIdentity } from "../../../server/db/analysis-queries";
import { db } from "../../../server/db";
import { laps, sessions } from "../../../server/db/schema";
import { finalizeLapQualityGeneration } from "../../../server/lap-analysis/quality-generation";
import { lapRoutes } from "../../../server/routes/laps";
import { persistCompletedLapFindings } from "../../../server/findings/completed-lap";
import { getCurrentFindingGeneration } from "../../../server/findings/store";
import { CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS } from "../../../shared/racing/analysis/laps/semantic-frame";
import { initGameAdapters } from "../../../shared/games/init";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { initServerGameAdapters } from "../../../server/games/init";
import { LiveTelemetryProjector } from "../../../server/telemetry/live-projector";
import { qualityPackets, summarize } from "../../support/lap-analysis/quality-model";

initGameAdapters();
initServerGameAdapters();

const createdSessionIds: number[] = [];
const createdThreadIds: string[] = [];

afterEach(async () => {
  const memory = getChatMemory();
  for (const threadId of createdThreadIds) {
    try {
      await memory.deleteThread(threadId);
    } catch {
      // Best-effort cleanup when route already deleted current thread.
    }
  }
  createdThreadIds.length = 0;
  for (const sessionId of createdSessionIds) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  createdSessionIds.length = 0;
});

async function insertComparisonLaps(): Promise<[number, number, string]> {
  const packets = qualityPackets(100);
  const telemetry = semanticSamplesFromPackets(packets);
  const sessionId = (await db.insert(sessions).values({ gameId: "fm-2023", carOrdinal: 4_001, trackOrdinal: 4_002 }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(sessionId);
  const ids: number[] = [];
  for (const lapNumber of [1, 2]) {
    const generated = finalizeLapQualityGeneration(summarize(packets), `sha256:${String(lapNumber + 4).repeat(64)}`, {
      lapNumber,
      rawByteOffset: lapNumber * 1_000,
      rawFrameCount: packets.length,
    });
    const row = await db
      .insert(laps)
      .values({
        sessionId,
        lapNumber,
        lapTime: 90 + lapNumber,
        isValid: true,
        quality: generated.quality,
        eligibility: generated.eligibility,
        qualityGeneration: generated.quality.provenance.outputGeneration,
        qualitySchemaVersion: generated.quality.provenance.schemaVersion,
        qualityPolicyVersion: generated.quality.provenance.policyVersion,
        qualityConfigVersion: generated.quality.provenance.configurationVersion,
      })
      .returning({ id: laps.id })
      .get();
    ids.push(row.id);
    await persistCompletedLapFindings(
      {
        lapId: row.id,
        sessionId,
        lapNumber,
        lapTime: 90 + lapNumber,
        isValid: true,
        gameId: "fm-2023",
        quality: generated.quality,
        recordingQuality: { valid: true, reason: null },
        versionIdentity: generated.quality.versionIdentity,
        telemetry,
      },
      { analyze: () => [] },
    );
  }
  const generations = [];
  for (const lapId of ids) {
    generations.push(
      await getCurrentFindingGeneration({
        kind: "lap",
        gameId: "fm-2023",
        sessionId: String(sessionId),
        lapId: String(lapId),
      }),
    );
  }
  if (!generations[0] || !generations[1]) throw new Error("Expected current finding generations");
  const findingGenerationKey = compareFindingGenerationCacheKey([
    { lapId: ids[0]!, receipt: generations[0].receipt },
    { lapId: ids[1]!, receipt: generations[1].receipt },
  ]);
  return [ids[0]!, ids[1]!, findingGenerationKey];
}

function semanticSamplesFromPackets(packets: readonly TelemetryPacket[]): SemanticTelemetrySample[] {
  const projector = new LiveTelemetryProjector(CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS);
  const samples: SemanticTelemetrySample[] = [];
  for (const packet of packets) {
    samples.push(
      projector.project({
        packet,
        receivedAtMs: packet.TimestampMS,
      }).sample,
    );
  }
  return samples;
}

describe("quality-scoped comparison chat routes", () => {
  test("returns canonical current thread and never deletes prior quality history", async () => {
    const [lapAId, lapBId, findingGenerationKey] = await insertComparisonLaps();
    const identity = await getCompareQualityIdentity(lapAId, lapBId);
    if (!identity) throw new Error("Expected current comparison quality identity");
    const currentThread = compareChatThreadId(lapAId, lapBId, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`);
    const previousThread = compareChatThreadId(lapAId, lapBId, "previous-policy:previous-generations");
    createdThreadIds.push(currentThread, previousThread);
    await saveChatMessages(previousThread, [{ role: "user", markdown: "previous comparison message" }]);
    await saveChatMessages(currentThread, [{ role: "user", markdown: "current comparison message" }]);

    const historyResponse = await lapRoutes.request(`/api/laps/${lapAId}/compare/${lapBId}/chat`, {
      headers: { "X-Game-Id": "fm-2023" },
    });
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as { threadId: string | null; messages: unknown[] };
    expect(history.threadId).toBe(currentThread);
    expect(JSON.stringify(history.messages)).toContain("current comparison message");
    expect(JSON.stringify(history.messages)).not.toContain("previous comparison message");

    const deleteResponse = await lapRoutes.request(`/api/laps/${lapAId}/compare/${lapBId}/chat`, {
      method: "DELETE",
      headers: { "X-Game-Id": "fm-2023" },
    });
    expect(deleteResponse.status).toBe(200);
    const memory = getChatMemory();
    expect(await memory.getThreadById({ threadId: currentThread })).toBeNull();
    expect(await memory.getThreadById({ threadId: previousThread })).not.toBeNull();
  });
});
