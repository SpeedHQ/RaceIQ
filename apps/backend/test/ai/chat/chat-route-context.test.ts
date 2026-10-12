import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { RequestContext } from "@mastra/core/request-context";
import { db } from "@raceiq/backend-core/db/index";
import { lapAnalyses, laps, sessions, tunes } from "@raceiq/backend-core/db/schema";
import { getAnalysis, saveAnalysis } from "@raceiq/backend-core/db/analysis-queries";
import { chatThreadId } from "@raceiq/backend-core/ai/chat-agent";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../../src/games/init";
import { createChatRoutes } from "../../../src/routes/laps/chat-routes";
import { buildLapChatInstructions } from "../../../src/mastra/agents/lap-chat";
import { setupContextForLap } from "../../../src/ai/lap-setup-context";

initGameAdapters();
initServerGameAdapters();

const fixtures: Array<{ id: number; sessionId: number; tuneId: number }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await db.delete(lapAnalyses).where(eq(lapAnalyses.lapId, fixture.id)).run();
    await db.delete(laps).where(eq(laps.id, fixture.id)).run();
    await db.delete(sessions).where(eq(sessions.id, fixture.sessionId)).run();
    await db.delete(tunes).where(eq(tunes.id, fixture.tuneId)).run();
  }
});

async function makeLapFixture(lapNumber: number, label: string) {
  const session = await db.insert(sessions).values({
    carId: "1", trackId: "19", gameId: "fm-2023", rawFile: null,
  }).returning({ id: sessions.id }).get();
  const tune = await db.insert(tunes).values({
    gameId: "fm-2023",
    name: `Test setup ${label}`,
    author: "route test",
    carId: "1",
    category: "race",
    trackId: "19",
    settings: JSON.stringify({ setupLabel: label }),
  }).returning({ id: tunes.id }).get();
  const lapRow = await db.insert(laps).values({
    sessionId: session!.id, tuneId: tune!.id, lapNumber, lapTime: 91.234, isValid: true,
  }).returning({ id: laps.id }).get();
  fixtures.push({ id: lapRow!.id, sessionId: session!.id, tuneId: tune!.id });
  const setupContext = setupContextForLap({
    id: lapRow!.id,
    gameId: "fm-2023",
    carId: "1",
    trackId: "19",
    carSetup: null,
    telemetry: [telemetry] as never,
  }, undefined, {
    id: tune!.id, gameId: "fm-2023", carId: "1", trackId: "19", settings: { setupLabel: label },
  });
  await saveAnalysis(lapRow!.id, JSON.stringify({
    verdict: `analysis-${label}`,
    pace: [],
    handling: [],
    corners: [],
    technique: [],
    setup: [],
    setupProvenance: {
      gameId: setupContext.gameId ?? null,
      gameVersion: null,
      carModel: setupContext.carModel ?? null,
      carVersion: null,
      trackName: setupContext.trackName ?? null,
      setupVersion: setupContext.setupVersion ?? null,
      lapId: setupContext.lapId ?? null,
    },
  }), {
    inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1, model: "fixture",
  });
  return { id: lapRow!.id, lapNumber, tuneId: tune!.id };
}
function makeMemory() {
  const threads = new Map<string, Array<Record<string, unknown>>>();
  return {
    threads,
    getThreadById: async ({ threadId }: { threadId: string }) => threads.has(threadId) ? { id: threadId } : null,
    recall: async ({ threadId }: { threadId: string }) => ({ messages: threads.get(threadId) ?? [] }),
    saveMessages: async ({ threadId, messages }: { threadId: string; messages: Array<Record<string, unknown>> }) => {
      threads.set(threadId, [...(threads.get(threadId) ?? []), ...messages]);
      return { messages };
    },
    deleteMessages: async (ids: string[]) => {
      for (const [threadId, messages] of threads) threads.set(threadId, messages.filter((message) => !ids.includes(String(message.id))));
    },
    deleteThread: async (threadId: string) => { threads.delete(threadId); },
  };
}
const telemetry = {
  gameId: "fm-2023", carId: "1", trackId: "19", CarClass: 0, CarPerformanceIndex: 0, DrivetrainType: 0,
  TireTempFL: 32, TireTempFR: 32, TireTempRL: 32, TireTempRR: 32,
  TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, Gear: 1,
  SuspensionTravelMFL: 0, SuspensionTravelMFR: 0, SuspensionTravelMRL: 0, SuspensionTravelMRR: 0,
};

function lap(fixture: { id: number; lapNumber: number; tuneId: number }) {
  return {
    id: fixture.id, lapNumber: fixture.lapNumber, lapTime: 91.234, isValid: true,
    telemetry: [telemetry], gameId: "fm-2023", trackId: "19", carId: "1",
    tuneId: fixture.tuneId,
  };
}

describe("lap chat route context and targeted removal", () => {
  test("passes current lap, analysis and setup into real lap-chat instructions on each turn", async () => {
    const firstLap = await makeLapFixture(51, "SETUP-41");
    const secondLap = await makeLapFixture(62, "SETUP-52");
    const fixturesById = new Map([[firstLap.id, firstLap], [secondLap.id, secondLap]]);
    const memory = makeMemory();
    const contexts: RequestContext[] = [];
    const app = createChatRoutes({
      getLapById: async (id) => lap(fixturesById.get(Number(id))!) as never,
      loadSettings: (() => ({ chatProvider: "openai", chatModel: "gpt-4o-mini", unit: "metric", temperatureUnit: "C", language: "en", chatThinkingBudget: 0 })) as never,
      resolveLapCorners: (async () => []) as never,
      getOrComputeLapInsights: (async () => []) as never,
      resolveActiveThread: (async (base: string) => base) as never,
      ensureSystemPrompt: (async () => {}) as never,
      configureAiProviderEnvironment: (async () => {}) as never,
      getChatMemory: (() => memory) as never,
      lapChatAgent: ({
        stream: async (_messages: unknown, options: { requestContext: RequestContext }) => {
          contexts.push(options.requestContext);
          return {};
        },
      } as never),
      streamAgentTurnResponse: (async () => new Response("ok")) as never,
    });

    for (const fixture of [firstLap, secondLap]) {
      const response = await app.request(`/api/laps/${fixture.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ id: `turn-${fixture.id}`, role: "user", parts: [{ type: "text", text: "follow up" }] }] }),
      });
      expect(response.status).toBe(200);
    }
    expect(contexts).toHaveLength(2);
    const first = buildLapChatInstructions(contexts[0]);
    const second = buildLapChatInstructions(contexts[1]);
    expect(first).toContain(`Current lap: Lap #51 — 91.234s`);
    expect(first).toContain(`Internal lap reference (for RaceIQ tools only; never ask the driver to look it up): ${firstLap.id}`);
    expect(first).toContain("Verdict: analysis-SETUP-41");
    expect(first).toContain("Game-specific setup: setupLabel: SETUP-41");
    expect(second).toContain(`Current lap: Lap #62 — 91.234s`);
    expect(second).toContain(`Internal lap reference (for RaceIQ tools only; never ask the driver to look it up): ${secondLap.id}`);
    expect(second).toContain("Verdict: analysis-SETUP-52");
    expect(second).toContain("Game-specific setup: setupLabel: SETUP-52");
  });

  test("excludes mismatched and unreadable linked setups without losing lap or analysis context", async () => {
    const fixture = await makeLapFixture(55, "ASSOCIATION");
    const prompts: string[] = [];
    const app = createChatRoutes({
      getLapById: async () => lap(fixture) as never,
      loadSettings: (() => ({ chatProvider: "openai", chatModel: "gpt-4o-mini", unit: "metric", temperatureUnit: "C", language: "en", chatThinkingBudget: 0 })) as never,
      resolveLapCorners: (async () => []) as never,
      getOrComputeLapInsights: (async () => []) as never,
      resolveActiveThread: (async (base: string) => base) as never,
      ensureSystemPrompt: (async () => {}) as never,
      configureAiProviderEnvironment: (async () => {}) as never,
      getChatMemory: (() => makeMemory()) as never,
      lapChatAgent: {
        stream: async (_messages, options) => {
          prompts.push(buildLapChatInstructions(options.requestContext));
          return {};
        },
      },
      streamAgentTurnResponse: (async () => new Response("ok")) as never,
    });
    for (const invalid of [
      { gameId: "ac-evo" },
      { carId: "2" },
      { trackId: "20" },
      { settings: "{malformed" },
      { settings: "[]" },
      { settings: "null" },
    ]) {
      await db.update(tunes).set({
        gameId: "fm-2023", carId: "1", trackId: "19",
        settings: JSON.stringify({ setupLabel: "UNRELATED-SETUP" }),
        ...invalid,
      }).where(eq(tunes.id, fixture.tuneId)).run();
      const response = await app.request(`/api/laps/${fixture.id}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ id: "follow-up", role: "user", parts: [{ type: "text", text: "Explain this lap" }] }] }),
      });
      expect(response.status).toBe(200);
      const instructions = prompts.at(-1)!;
      expect(instructions).not.toContain("UNRELATED-SETUP");
      expect(instructions).toContain("Lap #55");
      expect(instructions).toContain("analysis-ASSOCIATION");
    }
  });

  test("targeted user-turn removal preserves other messages and clear only removes chat memory", async () => {
    const fixture = await makeLapFixture(51, "REMOVE");
    const threadId = chatThreadId(fixture.id);
    const memory = makeMemory();
    memory.threads.set(threadId, [
      { id: "target", role: "user", content: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" }] },
      { id: "answer", role: "assistant", content: "answer" },
      { id: "other", role: "user", content: "keep" },
    ]);
    const receivedMessages: unknown[][] = [];
    const app = createChatRoutes({
      getLapById: async () => lap(fixture) as never,
      getChatMemory: (() => memory) as never,
      resolveActiveThread: (async (base: string) => base) as never,
      loadSettings: (() => ({ chatProvider: "openai", chatModel: "gpt-4o-mini", unit: "metric", temperatureUnit: "C", language: "en", chatThinkingBudget: 0 })) as never,
      resolveLapCorners: (async () => []) as never,
      getOrComputeLapInsights: (async () => []) as never,
      ensureSystemPrompt: (async () => {}) as never,
      configureAiProviderEnvironment: (async () => {}) as never,
      lapChatAgent: ({
        stream: async (messages: unknown[]) => {
          receivedMessages.push(messages);
          return {};
        },
      } as never),
      streamAgentTurnResponse: (async () => new Response("ok")) as never,
    });

    const removed = await app.request(`/api/laps/${fixture.id}/chat/messages/target`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await memory.recall({ threadId })).messages.map((message) => message.id)).toEqual(["answer", "other"]);
    expect(JSON.stringify(await memory.recall({ threadId }))).not.toContain("data:image/png");

    const missing = await app.request(`/api/laps/${fixture.id}/chat/messages/unsaved-failed-turn`, { method: "DELETE" });
    expect(missing.status).toBe(200);
    const followup = await app.request(`/api/laps/${fixture.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [
        { id: "answer", role: "assistant", parts: [{ type: "text", text: "answer" }] },
        { id: "other", role: "user", parts: [{ type: "text", text: "keep" }] },
      ] }),
    });
    expect(followup.status).toBe(200);
    expect(JSON.stringify(receivedMessages)).not.toContain("data:image/png");
    const reloaded = await app.request(`/api/laps/${fixture.id}/chat`);
    expect(JSON.stringify(await reloaded.json())).not.toContain("data:image/png");
    const analysisBeforeClear = await getAnalysis(fixture.id);
    expect(analysisBeforeClear).not.toBeNull();
    const cleared = await app.request(`/api/laps/${fixture.id}/chat`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect((await memory.recall({ threadId })).messages).toEqual([]);
    expect(await getAnalysis(fixture.id)).toEqual(analysisBeforeClear);
  });
  test("rejects known text-only image models before provider setup or stream", async () => {
    let providerConfigured = false;
    let streamCalled = false;
    let model = "o3-mini";
    const memory = makeMemory();
    const app = createChatRoutes({
      getLapById: async () => lap({ id: 41, lapNumber: 51, tuneId: 0 }) as never,
      loadSettings: (() => ({ chatProvider: "openai", chatModel: model, unit: "metric", temperatureUnit: "celsius", language: "en", chatThinkingBudget: 0 })) as never,
      resolveLapCorners: (async () => []) as never,
      buildChatSystemPrompt: (() => "context") as never,
      getOrComputeLapInsights: (async () => []) as never,
      resolveActiveThread: (async (base: string) => base) as never,
      ensureSystemPrompt: (async () => {}) as never,
      getChatMemory: (() => memory) as never,
      configureAiProviderEnvironment: (async () => { providerConfigured = true; }) as never,
      lapChatAgent: ({ stream: async () => { streamCalled = true; return {}; } } as never),
      streamAgentTurnResponse: (async () => new Response("ok")) as never,
    });
    const postImage = () => app.request("/api/laps/41/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "image-turn", role: "user", parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" }] }] }),
    });
    expect((await postImage()).status).toBe(400);
    expect(providerConfigured).toBe(false);
    expect(streamCalled).toBe(false);
    model = "o5";
    expect((await postImage()).status).toBe(400);
    expect(providerConfigured).toBe(false);
    expect(streamCalled).toBe(false);
    model = "gpt-4o-mini";
    expect((await postImage()).status).toBe(200);
    expect(providerConfigured).toBe(true);
    expect(streamCalled).toBe(true);
  });
});
