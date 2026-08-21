import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { chatThreadId, getChatMemory, saveChatMessages } from "../../../server/ai/chat-agent";
import { getLapQualityIdentity } from "../../../server/db/analysis-queries";
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

async function insertCurrentQualityLap(): Promise<number> {
  const packets = qualityPackets(100);
  const generated = finalizeLapQualityGeneration(summarize(packets), `sha256:${"3".repeat(64)}`, {
    lapNumber: 1,
    rawByteOffset: 1_000,
    rawFrameCount: packets.length,
  });
  const sessionId = (await db.insert(sessions).values({ gameId: "fm-2023", carOrdinal: 3_001, trackOrdinal: 3_002 }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(sessionId);
  return (
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
}

describe("quality-scoped lap chat routes", () => {
  test("returns canonical current thread and never deletes prior quality history", async () => {
    const lapId = await insertCurrentQualityLap();
    const identity = await getLapQualityIdentity(lapId);
    if (!identity) throw new Error("Expected current lap quality identity");
    const currentThread = chatThreadId(lapId, `${identity.policyVersion}:${identity.generation}`);
    const previousThread = chatThreadId(lapId, "previous-policy:previous-generation");
    createdThreadIds.push(currentThread, previousThread);
    await saveChatMessages(previousThread, [{ role: "user", markdown: "previous quality message" }]);
    await saveChatMessages(currentThread, [{ role: "user", markdown: "current quality message" }]);

    const historyResponse = await lapRoutes.request(`/api/laps/${lapId}/chat`);
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as { threadId: string | null; messages: unknown[] };
    expect(history.threadId).toBe(currentThread);
    expect(JSON.stringify(history.messages)).toContain("current quality message");
    expect(JSON.stringify(history.messages)).not.toContain("previous quality message");

    const deleteResponse = await lapRoutes.request(`/api/laps/${lapId}/chat`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
    const memory = getChatMemory();
    expect(await memory.getThreadById({ threadId: currentThread })).toBeNull();
    expect(await memory.getThreadById({ threadId: previousThread })).not.toBeNull();
  });
});
