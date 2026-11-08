import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../../src/games/init";
import { db } from "@raceiq/backend-core/db/index";
import { lapAnalyses, laps, sessions } from "@raceiq/backend-core/db/schema";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { saveAnalysis } from "@raceiq/backend-core/db/analysis-queries";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { cacheDelete } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { setupContextForLap } from "../../../src/ai/lap-setup-context";
import { resolveLapCorners } from "../../../src/tracks/corner-resolution";
import { createChatRoutes } from "../../../src/routes/laps/chat-routes";

const LIVE = process.env.LM_STUDIO_E2E === "1" && !process.env.CI;
const describeLive = LIVE ? describe : describe.skip;
const BASE_URL = process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1";
const MODEL = process.env.LM_STUDIO_MODEL ?? "qwen/qwen3.5-9b";
const FIXTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
let lapId = 0;
let sessionIds: number[] = [];
let originalSettings: string | undefined;

beforeAll(async () => {
  if (!LIVE) return;
  initGameAdapters();
  initServerGameAdapters();
  originalSettings = JSON.stringify(loadSettings());
  saveSettings({ ...loadSettings(), chatProvider: "openai-compatible", chatModel: MODEL, localEndpoint: BASE_URL, unit: "metric", temperatureUnit: "C", language: "en", chatThinkingBudget: 0 });
  const imported = await importSessionBin(readFileSync(FIXTURE), "fm-2023", { notifyDriverProfile: false });
  sessionIds = [...new Set(imported.laps.map((lap) => lap.sessionId))];
  for (const metadata of imported.laps) {
    if (metadata.lapNumber !== 0 || metadata.lapTime <= 10) continue;
    cacheDelete(metadata.lapId);
    const lap = await getLapById(metadata.lapId);
    if (lap?.isValid && lap.lapTime > 10) {
      lapId = lap.id;
      break;
    }
  }
  if (!lapId) throw new Error("Recording fixture has no complete valid measured first lap");
}, 180000);

afterAll(async () => {
  if (!LIVE) return;
  if (lapId) await createChatRoutes().request(`/api/laps/${lapId}/chat`, { method: "DELETE" });
  if (lapId) await db.delete(lapAnalyses).where(eq(lapAnalyses.lapId, lapId)).run();
  for (const sid of sessionIds) {
    await db.delete(laps).where(eq(laps.sessionId, sid)).run();
    await db.delete(sessions).where(eq(sessions.id, sid)).run();
  }
  if (originalSettings !== undefined) saveSettings(JSON.parse(originalSettings));
});


async function cacheVerdict(verdict: string) {
  const lap = await getLapById(lapId);
  if (!lap) throw new Error(`Imported lap ${lapId} disappeared`);
  const setup = setupContextForLap({ id: lapId, gameId: lap.gameId, carId: lap.carId, trackId: lap.trackId, carSetup: lap.carSetup, telemetry: lap.telemetry }, undefined);
  await saveAnalysis(lapId, JSON.stringify({ verdict, pace: [], handling: [], corners: [], technique: [], setup: [], setupProvenance: { gameId: setup.gameId ?? null, gameVersion: null, carModel: setup.carModel ?? null, carVersion: null, trackName: setup.trackName ?? null, setupVersion: setup.setupVersion ?? null, lapId: setup.lapId ?? null } }), { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1, model: "fixture-not-model-generated" });
}

interface ChatEvalEvent {
  type: string;
  [key: string]: unknown;
}

async function ask(text: string) {
  const app = createChatRoutes();
  const message = { id: `eval-${Date.now()}`, role: "user", parts: [{ type: "text", text }] };
  const response = await app.request(`/api/laps/${lapId}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [message] }) });
  if (!response.ok) throw new Error(`Chat route ${response.status}: ${await response.text()}`);
  const raw = await response.text();
  const events: ChatEvalEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* protocol metadata */ }
  }
  expect(events.filter((event) => event.type.includes("error"))).toEqual([]);
  const answer = events.filter((event) => event.type === "text-delta").map((event) => String(event.delta ?? "")).join("");
  console.info(JSON.stringify({
    event: "analyse-chat-live-case",
    question: text,
    answer,
    tools: events.filter((event) => event.type === "tool-input-available").map((input) => ({
      name: input.toolName,
      input: input.input,
      output: events.find((event) => event.type === "tool-output-available" && event.toolCallId === input.toolCallId)?.output,
    })),
  }));
  return { events, text: answer };
}

function toolInput(result: { events: ChatEvalEvent[] }, toolName: string) {
  return result.events.find((event) => event.type === "tool-input-available" && event.toolName === toolName);
}

function toolOutput(result: { events: ChatEvalEvent[] }, input: ChatEvalEvent | undefined) {
  if (!input) return undefined;
  return result.events.find((event) => event.type === "tool-output-available" && event.toolCallId === input.toolCallId);
}

// Opt-in integration tests use real imported recorded telemetry and live provider/tools. Cached verdicts below are controlled schema-valid fixtures, not generated analyses.
describeLive("Analyse lap chat live tool regressions", () => {
  test("measured Turn1 queries current lap metrics and grounds measured speeds", async () => {
    const lap = await getLapById(lapId);
    if (!lap) throw new Error("Imported lap unavailable");
    const result = await ask("For Turn 1, give my measured entry, minimum and exit speeds rounded to whole km/h.");
    const corners = await resolveLapCorners(lap.trackId, lap.gameId, lap.telemetry);
    const t1 = corners.find((corner) => corner.label.split(/[,/-]/).includes("T1") || corner.label === "T1");
    const input = toolInput(result, "get_corner_metrics");
    expect(input).toBeDefined();
    const args = input!.input as Record<string, unknown>;
    expect(args.lapId).toBe(lapId);
    expect(args.cornerId).toBe(1);
    const outputEvent = toolOutput(result, input);
    expect(outputEvent).toBeDefined();
    const output = outputEvent!.output as Record<string, unknown>;
    expect(output.lapId).toBe(lapId);
    expect(output.available).toBe(true);
    const corner = (output.corners as Array<Record<string, unknown>>)[0];
    expect(corner).toBeDefined();
    expect(corner.label).toContain("T1");
    expect(output.speedUnit).toBe("kmh");
    if (!t1) throw new Error("Recorded lap has no canonical T1");
    const firstDistance = lap.telemetry[0].DistanceTraveled;
    const spanSpeeds = lap.telemetry.filter((packet) => {
      const distance = packet.DistanceTraveled - firstDistance;
      return distance >= t1.distanceStart && distance <= t1.distanceEnd;
    }).map((packet) => Math.hypot(packet.VelocityX, packet.VelocityY, packet.VelocityZ) * 3.6);
    if (!spanSpeeds.length) throw new Error("Recorded T1 has no timed telemetry");
    expect(corner.label).toBe(t1.label);
    const expected = {
      entrySpeed: spanSpeeds[0],
      minSpeed: Math.min(...spanSpeeds),
      exitSpeed: spanSpeeds[spanSpeeds.length - 1],
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(Number(corner[key])).toBeCloseTo(value, 6);
    }
    expect(lap.id).not.toBe(lap.lapNumber);
    const finalText = result.text.toLowerCase();
    expect(finalText).toContain("km/h");
    const statedNumbers = [...finalText.matchAll(/\b\d+(?:\.\d+)?\b/g)].map(match => Number(match[0]));
    for (const key of ["entrySpeed", "minSpeed", "exitSpeed"]) {
      expect(statedNumbers).toContain(Math.round(Number(corner[key])));
    }
  }, 180000);

  test("fetches and quotes cached lap verdict with internal lap id", async () => {
    await cacheVerdict("CONTROLLED_CACHE_VERDICT_ALPHA");
    const result = await ask("Use get_lap_analysis to fetch my cached analysis, then quote its verdict exactly.");
    const input = toolInput(result, "get_lap_analysis");
    expect(input).toBeDefined();
    expect((input!.input as Record<string, unknown>).lapId).toBe(lapId);
    const output = toolOutput(result, input);
    expect(output).toBeDefined();
    expect((output!.output as Record<string, unknown>).lapId).toBe(lapId);
    expect(result.text).toContain("CONTROLLED_CACHE_VERDICT_ALPHA");
  }, 180000);

  test("same thread uses refreshed cache and remembers prior driver dialogue without tools", async () => {
    await cacheVerdict("CONTROLLED_CACHE_VERDICT_OLD");
    const memoryToken = `DRIVER_NOTE_${crypto.randomUUID().slice(0, 8)}`;
    const first = await ask(`Without tools, quote the current verdict and remember this driver note: ${memoryToken}`);
    expect(first.text).toContain("CONTROLLED_CACHE_VERDICT_OLD");
    expect(first.text).toContain(memoryToken);
    await cacheVerdict("CONTROLLED_CACHE_VERDICT_NEW");
    const followup = await ask("Without tools, quote the current verdict and repeat the driver note I gave earlier.");
    expect(toolInput(followup, "get_lap_analysis")).toBeUndefined();
    expect(toolInput(followup, "get_corner_metrics")).toBeUndefined();
    expect(followup.text).toContain("CONTROLLED_CACHE_VERDICT_NEW");
    expect(followup.text).not.toContain("CONTROLLED_CACHE_VERDICT_OLD");
    expect(followup.text).toContain(memoryToken);
  }, 360000);

  test("missing corner reports tool reason without invented measurements or cached verdict", async () => {
    const result = await ask("Give measured entry, minimum and exit speeds for Turn 999.");
    const input = toolInput(result, "get_corner_metrics");
    expect(input).toBeDefined();
    const args = input!.input as Record<string, unknown>;
    expect(args.lapId).toBe(lapId);
    expect(args.cornerId).toBe(999);
    const outputEvent = toolOutput(result, input);
    expect(outputEvent).toBeDefined();
    const output = outputEvent!.output as Record<string, unknown>;
    expect(output.available).toBe(false);
    expect(String(output.reason)).toContain("corner 999 not found");
    expect(result.text).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:km\/h|kmh|mph)\b/i);
    expect(result.text).not.toContain("CONTROLLED_CACHE_VERDICT");
    expect(toolInput(result, "generate_lap_analysis")).toBeUndefined();
  }, 180000);
});
