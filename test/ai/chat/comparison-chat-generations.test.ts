import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { compareChatThreadId, getChatMemory, saveChatMessages } from "../../../server/ai/chat-agent";
import { getCompareQualityIdentity } from "../../../server/db/analysis-queries";
import { db } from "../../../server/db";
import { laps, sessions } from "../../../server/db/schema";
import { finalizeLapQualityGeneration } from "../../../server/lap-analysis/quality-generation";
import { lapRoutes } from "../../../server/routes/laps";
import { qualityPackets, summarize } from "../../support/lap-analysis/quality-model";

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

async function insertComparisonLaps(): Promise<[number, number]> {
  const packets = qualityPackets(100);
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
  }
  return [ids[0]!, ids[1]!];
}

describe("quality-scoped comparison chat routes", () => {
  test("returns canonical current thread and never deletes prior quality history", async () => {
    const [lapAId, lapBId] = await insertComparisonLaps();
    const identity = await getCompareQualityIdentity(lapAId, lapBId);
    if (!identity) throw new Error("Expected current comparison quality identity");
    const currentThread = compareChatThreadId(lapAId, lapBId, `${identity.policyVersion}:${identity.generation}`);
    const previousThread = compareChatThreadId(lapAId, lapBId, "previous-policy:previous-generations");
    createdThreadIds.push(currentThread, previousThread);
    await saveChatMessages(previousThread, [{ role: "user", markdown: "previous comparison message" }]);
    await saveChatMessages(currentThread, [{ role: "user", markdown: "current comparison message" }]);

    const historyResponse = await lapRoutes.request(`/api/laps/${lapAId}/compare/${lapBId}/chat`);
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as { threadId: string | null; messages: unknown[] };
    expect(history.threadId).toBe(currentThread);
    expect(JSON.stringify(history.messages)).toContain("current comparison message");
    expect(JSON.stringify(history.messages)).not.toContain("previous comparison message");

    const deleteResponse = await lapRoutes.request(`/api/laps/${lapAId}/compare/${lapBId}/chat`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    const memory = getChatMemory();
    expect(await memory.getThreadById({ threadId: currentThread })).toBeNull();
    expect(await memory.getThreadById({ threadId: previousThread })).not.toBeNull();
  });
});
