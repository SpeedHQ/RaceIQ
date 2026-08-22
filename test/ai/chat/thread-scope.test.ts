import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { chatThreadId, getChatMemory, saveChatMessages } from "../../../server/ai/chat-agent";
import { getLapQualityIdentity } from "../../../server/db/analysis-queries";
import { lapFindingGenerationCacheKey } from "../../../server/db/analysis-queries";
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

async function insertCurrentQualityLap(): Promise<{ lapId: number; findingGenerationKey: string }> {
  const packets = qualityPackets(100);
  const telemetry = semanticSamplesFromPackets(packets);
  const generated = finalizeLapQualityGeneration(summarize(packets), `sha256:${"3".repeat(64)}`, {
    lapNumber: 1,
    rawByteOffset: 1_000,
    rawFrameCount: packets.length,
  });
  const sessionId = (await db.insert(sessions).values({ gameId: "fm-2023", carOrdinal: 3_001, trackOrdinal: 3_002 }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(sessionId);
  const lapId = (
    await db
      .insert(laps)
      .values({
        sessionId,
        lapNumber: 1,
        lapTime: 90,
        isValid: true,
        quality: generated.quality,
        eligibility: generated.eligibility,
        qualityGeneration: generated.quality.provenance.outputGeneration,
        qualitySchemaVersion: generated.quality.provenance.schemaVersion,
        qualityPolicyVersion: generated.quality.provenance.policyVersion,
        qualityConfigVersion: generated.quality.provenance.configurationVersion,
      })
      .returning({ id: laps.id })
      .get()
  ).id;
  await persistCompletedLapFindings(
    {
      lapId,
      sessionId,
      lapNumber: 1,
      lapTime: 90,
      isValid: true,
      gameId: "fm-2023",
      quality: generated.quality,
      recordingQuality: { valid: true, reason: null },
      versionIdentity: generated.quality.versionIdentity,
      telemetry,
    },
    { analyze: () => [] },
  );
  const findingGeneration = await getCurrentFindingGeneration({
    kind: "lap",
    gameId: "fm-2023",
    sessionId: String(sessionId),
    lapId: String(lapId),
  });
  if (!findingGeneration) throw new Error("Expected current finding generation");
  return {
    lapId,
    findingGenerationKey: lapFindingGenerationCacheKey(findingGeneration.receipt),
  };
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

describe("quality-scoped lap chat routes", () => {
  test("requires valid game identity on history, send, and delete", async () => {
    const missingHistory = await lapRoutes.request("/api/laps/999999/chat");
    expect(missingHistory.status).toBe(400);
    expect(await missingHistory.json()).toEqual({ error: "Missing or invalid X-Game-Id header" });

    const invalidDelete = await lapRoutes.request("/api/laps/999999/chat", {
      method: "DELETE",
      headers: { "X-Game-Id": "invalid" },
    });
    expect(invalidDelete.status).toBe(400);
    expect(await invalidDelete.json()).toEqual({ error: "Missing or invalid X-Game-Id header" });

    const missingPost = await lapRoutes.request("/api/laps/999999/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(missingPost.status).toBe(400);
    expect(await missingPost.json()).toEqual({ error: "Missing or invalid X-Game-Id header" });
  });

  test("rejects wrong-game history, send, and delete without touching chat memory", async () => {
    const { lapId, findingGenerationKey } = await insertCurrentQualityLap();
    const identity = await getLapQualityIdentity(lapId);
    if (!identity) throw new Error("Expected current lap quality identity");
    const threadId = chatThreadId(lapId, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`);
    createdThreadIds.push(threadId);
    await saveChatMessages(threadId, [{ role: "user", markdown: "must survive wrong game" }]);

    const wrongGameHeaders = { "X-Game-Id": "acc" };
    const historyResponse = await lapRoutes.request(`/api/laps/${lapId}/chat`, { headers: wrongGameHeaders });
    expect(historyResponse.status).toBe(404);
    expect(await historyResponse.json()).toEqual({ error: "Lap not found" });

    const sendResponse = await lapRoutes.request(`/api/laps/${lapId}/chat`, {
      method: "POST",
      headers: { ...wrongGameHeaders, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(sendResponse.status).toBe(404);
    expect(await sendResponse.json()).toEqual({ error: "Lap not found" });

    const deleteResponse = await lapRoutes.request(`/api/laps/${lapId}/chat`, {
      method: "DELETE",
      headers: wrongGameHeaders,
    });
    expect(deleteResponse.status).toBe(404);
    expect(await deleteResponse.json()).toEqual({ error: "Lap not found" });
    expect(await getChatMemory().getThreadById({ threadId })).not.toBeNull();
  });

  test("returns canonical current thread and never deletes prior quality history", async () => {
    const { lapId, findingGenerationKey } = await insertCurrentQualityLap();
    const identity = await getLapQualityIdentity(lapId);
    if (!identity) throw new Error("Expected current lap quality identity");
    const currentThread = chatThreadId(lapId, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`);
    const previousThread = chatThreadId(lapId, "previous-policy:previous-generation");
    createdThreadIds.push(currentThread, previousThread);
    await saveChatMessages(previousThread, [{ role: "user", markdown: "previous quality message" }]);
    await saveChatMessages(currentThread, [{ role: "user", markdown: "current quality message" }]);

    const historyResponse = await lapRoutes.request(`/api/laps/${lapId}/chat`, { headers: { "X-Game-Id": "fm-2023" } });
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as { threadId: string | null; messages: unknown[] };
    expect(history.threadId).toBe(currentThread);
    expect(JSON.stringify(history.messages)).toContain("current quality message");
    expect(JSON.stringify(history.messages)).not.toContain("previous quality message");

    const deleteResponse = await lapRoutes.request(`/api/laps/${lapId}/chat`, { method: "DELETE", headers: { "X-Game-Id": "fm-2023" } });
    expect(deleteResponse.status).toBe(200);
    const memory = getChatMemory();
    expect(await memory.getThreadById({ threadId: currentThread })).toBeNull();
    expect(await memory.getThreadById({ threadId: previousThread })).not.toBeNull();
  });
});
