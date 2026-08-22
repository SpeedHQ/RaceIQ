import { MessageList } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";

import type { FindingGenerationReceipt } from "../../../shared/racing/findings/types";
import { GameIdSchema, type GameId } from "../../../shared/games/ids";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import { eligibilityDecisionText } from "../../../shared/racing/quality/display";
import { isEligibilityUsable, resolveEligibilityDecision } from "../../../shared/racing/quality/policies";
import type { ComparisonData } from "../../../shared/racing/comparison/types";
import { queryLapTelemetryBySemanticId } from "../../telemetry/replay";
import { getLapById, getLapMetaById, type LoadedLap } from "../../db/lap-read-queries";
import {
  deleteCompareAnalysis,
  compareFindingGenerationCacheKey,
  getAnalysis,
  getCompareAnalysis,
  getCompareQualityIdentity,
  qualityCacheIdentityForComparison,
  saveCompareAnalysis,
} from "../../db/analysis-queries";
import { compareLaps, type ComparisonOptions } from "../../lap-analysis/comparison";
import { getCurrentFindingGeneration, type FindingGenerationExpectation } from "../../findings/store";
import { loadSettings } from "../../runtime/config/settings";
import { resolveLapCorners, resolveLapSegments } from "../../tracks/corner-resolution";
import { buildFindingsContext } from "../../ai/findings-context";
import { buildCompareChatSystemPrompt } from "../../ai/compare-chat-prompt";
import { buildInputsComparePrompt, InputsCompareSchema, type PromptSegment } from "../../ai/inputs-compare-prompt";
import { compareChatAgent, compareEngineerAgent } from "../../ai/agents";
import { buildGoogleReasoningProviderOptions, buildGoogleThinkingProviderOptions } from "../../ai/google-provider-options";
import { beginAnalysisRun, finishAnalysisRun, getAnalysisRun } from "../../ai/analysis-run-registry";
import { streamAgentTurnResponse } from "../../ai/agent-stream";
import {
  CHAT_RESOURCE_ID,
  compareChatThreadId,
  generationThreadId,
  getChatMemory,
  listThreadGenerations,
  resolveActiveThread,
} from "../../ai/chat-agent";
import { adaptComparisonToFindings } from "../../findings/comparison-adapter";
import { FINDING_RECEIPT_FENCE_CONTEXT_KEY } from "../../ai/chat-message-context";
import { AnalyseQuerySchema, ChatBodySchema, ChatHistoryQuerySchema, CompareParamsSchema, FindingGenerationBackfilling } from "./support";
import { getSecret } from "../../runtime/platform/keystore";
import { resolveTrack } from "../../tracks/info";
type GameOwnedLap = LoadedLap & { gameId: GameId };
type GameScopedLap = Pick<LapMeta, "id" | "sessionId"> & { gameId: GameId };
type GameOwnedLapMetadata = LapMeta & { gameId: GameId };
type ComparisonLapLoad =
  | { lapA: GameOwnedLap; lapB: GameOwnedLap }
  | { error: string; status: 404 | 422 };
type ComparisonLapMetadataLoad =
  | { lapA: GameOwnedLapMetadata; lapB: GameOwnedLapMetadata }
  | { error: string; status: 404 | 422 };

async function loadComparisonLapMetadata(
  id1: number,
  id2: number,
  gameId: GameId,
): Promise<ComparisonLapMetadataLoad> {
  const [lapA, lapB] = await Promise.all([getLapMetaById(id1), getLapMetaById(id2)]);
  if (!lapA || lapA.gameId !== gameId) return { error: `Lap ${id1} not found`, status: 404 };
  if (!lapB || lapB.gameId !== gameId) return { error: `Lap ${id2} not found`, status: 404 };
  if (lapA.trackOrdinal == null || lapB.trackOrdinal == null || lapA.trackOrdinal !== lapB.trackOrdinal) {
    return { error: "Laps must belong to same track", status: 422 };
  }
  return { lapA: { ...lapA, gameId }, lapB: { ...lapB, gameId } };
}

function requestedGameId(c: Context): GameId | null {
  const parsed = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
  return parsed.success ? parsed.data : null;
}

async function loadComparisonLaps(
  id1: number,
  id2: number,
  gameId: GameId,
): Promise<ComparisonLapLoad> {
  const [lapA, lapB] = await Promise.all([getLapById(id1), getLapById(id2)]);
  if (!lapA || lapA.gameId !== gameId) return { error: `Lap ${id1} not found`, status: 404 };
  if (!lapB || lapB.gameId !== gameId) return { error: `Lap ${id2} not found`, status: 404 };
  if (lapA.trackOrdinal == null || lapB.trackOrdinal == null || lapA.trackOrdinal !== lapB.trackOrdinal) {
    return { error: "Laps must belong to same track", status: 422 };
  }
  return { lapA: { ...lapA, gameId }, lapB: { ...lapB, gameId } };
}

async function loadStoredComparisonFindings(lapA: GameScopedLap, lapB: GameScopedLap) {
  const generationA = await getCurrentFindingGeneration({
    kind: "lap",
    gameId: lapA.gameId,
    sessionId: String(lapA.sessionId),
    lapId: String(lapA.id),
  });
  const generationB = await getCurrentFindingGeneration({
    kind: "lap",
    gameId: lapB.gameId,
    sessionId: String(lapB.sessionId),
    lapId: String(lapB.id),
  });
  return [generationA, generationB] as const;
}

function findingExpectationForLap(
  lap: GameScopedLap,
  receipt: Pick<FindingGenerationReceipt, "generationId" | "contentHash">,
): FindingGenerationExpectation {
  return {
    scope: {
      kind: "lap",
      gameId: lap.gameId,
      sessionId: String(lap.sessionId),
      lapId: String(lap.id),
    },
    generationId: receipt.generationId,
    contentHash: receipt.contentHash,
  };
}

/** Authoritative game-owned alignment policy shared by every comparison surface. */
function comparisonOptions(lapA: GameOwnedLap, lapB: GameOwnedLap): ComparisonOptions {
  return {
    lapAIsValid: lapA.isValid,
    lapBIsValid: lapB.isValid,
    trackLengthMeters: resolveTrack(lapA.gameId, lapA.trackOrdinal).lengthMeters,
  };
}

const inputsAnalysisRunKey = (idA: number, idB: number) => `inputs:${idA}:${idB}`;

export const comparisonRoutes = new Hono()
  .get("/api/laps/:id1/compare/:id2", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

    const gameId = requestedGameId(c);
    if (!gameId) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const comparisonLaps = await loadComparisonLaps(id1, id2, gameId);
    if (!("lapA" in comparisonLaps)) return c.json({ error: comparisonLaps.error }, comparisonLaps.status);
    const { lapA, lapB } = comparisonLaps;
    const decisions = {
      lapA: resolveEligibilityDecision(lapA, "lap-comparison"),
      lapB: resolveEligibilityDecision(lapB, "lap-comparison"),
    };
    if (!isEligibilityUsable(decisions.lapA) || !isEligibilityUsable(decisions.lapB)) {
      return c.json(
        {
          error: [decisions.lapA, decisions.lapB]
            .filter((decision) => !isEligibilityUsable(decision))
            .map(eligibilityDecisionText)
            .join(" "),
          decisions,
        },
        422,
      );
    }
    const [findingGenerationA, findingGenerationB] = await loadStoredComparisonFindings(lapA, lapB);
    if (!findingGenerationA || !findingGenerationB) {
      return c.json(FindingGenerationBackfilling, 409);
    }


    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);

    const trackOrdinal = lapA.trackOrdinal ?? 0;
    const corners = await resolveLapCorners(trackOrdinal, lapA.gameId, lapA.telemetry, {
      saveDetected: true,
    });
    const result = compareLaps(lapA.telemetry, lapB.telemetry, corners, comparisonOptions(lapA, lapB));
    const findings = adaptComparisonToFindings({
      gameId,
      sessionId: lapA.sessionId,
      sessionAId: lapA.sessionId,
      sessionBId: lapB.sessionId,
      lapAId: lapA.id,
      lapBId: lapB.id,
      result,
      referenceId: `lap:${lapB.id}`,
      referenceKind: "lap",
      referenceSelectionReason: "explicit route lap B reference for A-minus-B comparison",
      analysisGenerationId: `comparison:${lapA.id}:${lapB.id}:${lapA.derivationVersion ?? "legacy"}:${lapB.derivationVersion ?? "legacy"}`,
      ruleVersion: `${lapA.derivationVersion ?? "1"}:${lapB.derivationVersion ?? "1"}`,
    });
    const semanticIds = [
      "motion.position-x",
      "motion.position-z",
      "motion.yaw",
      "motion.speed",
      "inputs.accel",
      "inputs.brake",
      "engine.current-engine-rpm",
      "tires.tire-wear",
      "timing.distance-traveled",
      "timing.current-lap",
    ] as const;
    const [replayA, replayB] = await Promise.all([queryLapTelemetryBySemanticId(id1, semanticIds), queryLapTelemetryBySemanticId(id2, semanticIds)]);
    if (!replayA || !replayB || replayA.envelopes.length === 0 || replayB.envelopes.length === 0) {
      return c.json({ error: "One or both laps have no semantic telemetry data" }, 400);
    }
    const toSamples = (replay: typeof replayA) =>
      replay.envelopes.map((envelope) => ({
        sequence: envelope.sequence.toString(),
        observedAtMs: envelope.observedAt.domain === "monotonic" ? Number(envelope.observedAt.nanoseconds) / 1_000_000 : envelope.observedAt.milliseconds,
        values: Object.fromEntries(envelope.values.filter((entry) => entry.state === "ok").map((entry) => [entry.semanticId, entry.value])),
      }));

    const response: ComparisonData = {
      lapA: {
        id: lapA.id,
        sessionId: lapA.sessionId,
        lapNumber: lapA.lapNumber,
        lapTime: lapA.lapTime,
        isValid: lapA.isValid,
        trackOrdinal: lapA.trackOrdinal,
        carOrdinal: lapA.carOrdinal,
      },
      lapB: {
        id: lapB.id,
        sessionId: lapB.sessionId,
        lapNumber: lapB.lapNumber,
        lapTime: lapB.lapTime,
        isValid: lapB.isValid,
        trackOrdinal: lapB.trackOrdinal,
        carOrdinal: lapB.carOrdinal,
      },
      traces: {
        distance: result.distances,
        sourceIndicesA: result.lapA.sourceIndices,
        sourceIndicesB: result.lapB.sourceIndices,
        speedA: result.lapA.speed,
        speedB: result.lapB.speed,
        throttleA: result.lapA.throttle,
        throttleB: result.lapB.throttle,
        brakeA: result.lapA.brake,
        brakeB: result.lapB.brake,
        rpmA: result.lapA.rpm,
        rpmB: result.lapB.rpm,
        tireWearA: result.lapA.tireWear,
        tireWearB: result.lapB.tireWear,
      },
      timeDelta: result.timeDelta,
      corners: result.cornerDeltas,
      findings,
      telemetryA: toSamples(replayA),
      telemetryB: toSamples(replayB),
      findingReceipts: {
        lapA: {
          generationId: findingGenerationA.receipt.generationId,
          contentHash: findingGenerationA.receipt.contentHash,
          status: findingGenerationA.receipt.status,
        },
        lapB: {
          generationId: findingGenerationB.receipt.generationId,
          contentHash: findingGenerationB.receipt.contentHash,
          status: findingGenerationB.receipt.status,
        },
      },
      gameId,
    };
    return c.json({ ...response, decisions });
  })

  .get("/api/laps/:id1/compare/:id2/inputs-analyse/status", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const gameId = requestedGameId(c);
    if (!gameId) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const comparisonLaps = await loadComparisonLapMetadata(id1, id2, gameId);
    if (!("lapA" in comparisonLaps)) return c.json({ error: comparisonLaps.error }, comparisonLaps.status);
    return c.json(getAnalysisRun(inputsAnalysisRunKey(id1, id2)) ?? { status: "none" });
  })
  .post("/api/laps/:id1/compare/:id2/inputs-analyse", zValidator("param", CompareParamsSchema), zValidator("query", AnalyseQuerySchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const { regenerate, cacheOnly } = c.req.valid("query");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

    const gameId = requestedGameId(c);
    if (!gameId) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const comparisonLaps = await loadComparisonLaps(id1, id2, gameId);
    if (!("lapA" in comparisonLaps)) return c.json({ error: comparisonLaps.error }, comparisonLaps.status);
    const { lapA, lapB } = comparisonLaps;
    const qualityIdentity = qualityCacheIdentityForComparison([lapA, lapB]);
    const decisions = {
      lapA: resolveEligibilityDecision(lapA, "corner-trace"),
      lapB: resolveEligibilityDecision(lapB, "corner-trace"),
    };
    if (!isEligibilityUsable(decisions.lapA) || !isEligibilityUsable(decisions.lapB)) {
      return c.json(
        {
          error: [decisions.lapA, decisions.lapB]
            .filter((decision) => !isEligibilityUsable(decision))
            .map(eligibilityDecisionText)
            .join(" "),
          decisions,
        },
        422,
      );
    }
    if (!qualityIdentity) {
      return c.json({ error: "Compared laps have no current quality generation", decisions }, 422);
    }
    const [findingGenerationA, findingGenerationB] = await loadStoredComparisonFindings(lapA, lapB);
    if (!findingGenerationA || !findingGenerationB) {
      return c.json(FindingGenerationBackfilling, 409);
    }
    const expectedFindingGenerationPair = [
      findingExpectationForLap(lapA, findingGenerationA.receipt),
      findingExpectationForLap(lapB, findingGenerationB.receipt),
    ] as const;

    if (!regenerate) {
      const cached = await getCompareAnalysis(id1, id2, expectedFindingGenerationPair, "inputs");
      if (cached) {
        return c.json({
          analysis: cached.analysis,
          cached: true,
          decisions,
          usage: {
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens,
            costUsd: cached.costUsd,
            durationMs: cached.durationMs,
            model: cached.model,
          },
        });
      }
      if (cacheOnly) return c.json({ analysis: null, cached: false, decisions });
    }
    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);
    const findingsContext =
      buildFindingsContext(findingGenerationA.findings, { label: "Lap A" }) +
      buildFindingsContext(findingGenerationB.findings, { label: "Lap B" });


    const trackOrdinal = lapA.trackOrdinal ?? 0;
    const trackSegments = await resolveLapSegments(trackOrdinal, lapA.gameId);
    const corners = await resolveLapCorners(trackOrdinal, lapA.gameId, lapA.telemetry, {
      segments: trackSegments,
    });

    const comparison = compareLaps(lapA.telemetry, lapB.telemetry, corners, comparisonOptions(lapA, lapB));

    const settings = loadSettings();

    // Named track segments (corners + straights) for the per-segment breakdown.
    // Game-specific, and carrying the official turn numbers so the breakdown
    // names corners the same way the map and the track guide do.
    const segments: PromptSegment[] | null =
      trackSegments.map((s) => ({
        name: s.name,
        type: s.type === "corner" ? ("corner" as const) : ("straight" as const),
        startFrac: s.startFrac,
        endFrac: s.endFrac,
        number: s.number,
        covers: s.covers,
        group: s.group,
        direction: s.direction,
      })) ?? null;

    const prompt = buildInputsComparePrompt(
      {
        lapNumber: lapA.lapNumber,
        lapTime: lapA.lapTime,
        isValid: lapA.isValid,
        carOrdinal: lapA.carOrdinal ?? undefined,
        trackOrdinal: lapA.trackOrdinal ?? undefined,
        gameId: lapA.gameId as GameId | undefined,
        quality: lapA.quality,
        eligibility: lapA.eligibility,
        qualityGeneration: lapA.qualityGeneration,
      },
      {
        lapNumber: lapB.lapNumber,
        lapTime: lapB.lapTime,
        isValid: lapB.isValid,
        carOrdinal: lapB.carOrdinal ?? undefined,
        trackOrdinal: lapB.trackOrdinal ?? undefined,
        gameId: lapB.gameId as GameId | undefined,
        quality: lapB.quality,
        eligibility: lapB.eligibility,
        qualityGeneration: lapB.qualityGeneration,
      },
      comparison,
      segments,
      undefined,
      findingsContext,
    );

    // Set provider env vars before calling Mastra (the dynamic model resolver
    // reads settings at request time but env-based API keys must be in scope).
    if (!settings.aiProvider) {
      return c.json({ error: "No AI provider selected. Choose one in Settings → AI Analysis." }, 400);
    }
    if (settings.aiProvider === "openai") {
      const key = await getSecret("openai-api-key");
      if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Analysis." }, 400);
      process.env.OPENAI_API_KEY = key;
    } else if (settings.aiProvider === "local") {
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
      process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
    } else {
      const key = await getSecret("gemini-api-key");
      if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Analysis." }, 400);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
    }
    const inputsRunKey = inputsAnalysisRunKey(id1, id2);
    if (!beginAnalysisRun(inputsRunKey)) {
      return c.json({ error: "Inputs comparison already in progress" }, 409);
    }

    try {
      const start = performance.now();
      const result = await compareEngineerAgent.generate(prompt, {
        structuredOutput: {
          schema: InputsCompareSchema,
          // LM Studio only accepts `response_format: json_schema` (it rejects
          // json_object), and for reasoning models such as qwen3.5 it emits the
          // schema-constrained JSON into `reasoning_content` while leaving
          // `content` empty — so no object is ever parsed and this route throws.
          // Prompt injection keeps the answer on the plain-text channel, which
          // those models fill normally. Hosted providers parse native structured
          // output fine, so only the local path opts in.
          ...(settings.aiProvider === "local" ? { jsonPromptInjection: true } : {}),
        },
        // Every other AI route already caps output and disables reasoning on
        // local models (analyse, lap chat, compare chat). This one did not, so
        // a thinking model such as qwen3.5 could reason unboundedly and push the
        // request past Bun.serve's 255s idleTimeout — surfacing to the client as
        // a bare "socket hang up" from the Vite proxy.
        modelSettings: { maxOutputTokens: 8192, temperature: 0 },
        providerOptions: {
          openai: { reasoningEffort: "medium" },
          google: buildGoogleThinkingProviderOptions(settings.aiModel || "gemini-flash-latest", settings.aiThinkingBudget) as never,
        },
      });
      const durationMs = Math.round(performance.now() - start);

      const object = (result as any).object;
      if (!object) {
        throw new Error(
          settings.aiProvider === "local"
            ? `Model "${settings.aiModel}" returned no output matching the expected structure. Some local models do not reliably emit structured JSON — try another model in Settings → AI Analysis.`
            : "Compare engineer returned no structured object",
        );
      }

      // Merge server-authoritative segment types into the model response so
      // named corners never appear as "straight". Match by name first; fall
      // back to positional order (both lists are emitted in the same order).
      if (Array.isArray(object.segments) && segments) {
        const byName = new Map(segments.map((s) => [s.name, s.type]));
        object.segments = object.segments.map((seg: any, i: number) => ({
          ...seg,
          type: byName.get(seg.name) ?? segments[i]?.type ?? "straight",
        }));
      }
      const analysisJson = JSON.stringify(object);
      const totalUsage = (result as any).totalUsage ?? (result as any).usage ?? {};
      const usage = {
        inputTokens: totalUsage.inputTokens ?? totalUsage.promptTokens ?? 0,
        outputTokens: totalUsage.outputTokens ?? totalUsage.completionTokens ?? 0,
        costUsd: 0,
        durationMs,
        model: settings.aiModel || settings.aiProvider,
      };
      const saved = await saveCompareAnalysis(id1, id2, analysisJson, usage, qualityIdentity, expectedFindingGenerationPair, "inputs");
      if (!saved) {
        return c.json({ error: "Compared lap quality or findings changed during analysis generation. Analysis not cached." }, 409);
      }
      return c.json({ analysis: analysisJson, cached: false, usage });
    } catch (err: any) {
      console.error("[InputsCompare] Failed:", err.message);
      return c.json({ error: err.message }, err.message.includes("timed out") ? 504 : 500);
    } finally {
      finishAnalysisRun(inputsRunKey);
    }
  })

  .delete("/api/laps/:id1/compare/:id2/inputs-analyse", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const gameId = requestedGameId(c);
    if (!gameId) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const comparisonLaps = await loadComparisonLapMetadata(id1, id2, gameId);
    if (!("lapA" in comparisonLaps)) return c.json({ error: comparisonLaps.error }, comparisonLaps.status);
    try {
      await deleteCompareAnalysis(id1, id2, "inputs");
    } catch (err: any) {
      console.error("[InputsCompare] Failed to clear:", err.message);
    }
    return c.json({ ok: true });
  })

  .get("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), zValidator("query", ChatHistoryQuerySchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const gameId = requestedGameId(c);
    if (!gameId) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const comparisonLaps = await loadComparisonLapMetadata(id1, id2, gameId);
    if (!("lapA" in comparisonLaps)) return c.json({ error: comparisonLaps.error }, comparisonLaps.status);
    let base: string | null = null;
    try {
      const { lapA, lapB } = comparisonLaps;
      const [identity, findingGenerations] = await Promise.all([
        getCompareQualityIdentity(id1, id2),
        loadStoredComparisonFindings(lapA, lapB),
      ]);
      const [findingGenerationA, findingGenerationB] = findingGenerations;
      if (!identity) return c.json({ messages: [], threadId: null, status: "stale", retryable: true }, 409);
      if (!findingGenerationA || !findingGenerationB) {
        return c.json({ messages: [], threadId: null, ...FindingGenerationBackfilling }, 409);
      }
      const findingGenerationKey = compareFindingGenerationCacheKey([
        { lapId: lapA.id, receipt: findingGenerationA.receipt },
        { lapId: lapB.id, receipt: findingGenerationB.receipt },
      ]);
      base = compareChatThreadId(id1, id2, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`);
      const memory = getChatMemory();
      const gen = c.req.valid("query").gen;
      const threadId = gen === undefined ? await resolveActiveThread(base) : generationThreadId(base, gen);
      const thread = await memory.getThreadById({ threadId });
      if (!thread) {
        return c.json({
          messages: [],
          threadId: gen === undefined ? base : threadId,
          status: gen === undefined ? "current" : "stale",
        });
      }
      const result = await memory.recall({ threadId });
      const raw = result.messages ?? [];

      const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
      list.add(raw, "memory");
      const uiMessages = list.get.all.aiV5.ui().filter((message) => message.role === "user" || message.role === "assistant");
      return c.json({ messages: uiMessages, threadId: gen === undefined ? base : threadId, status: gen === undefined ? "current" : "stale" });
    } catch (err: any) {
      console.error("[CompareChat] Failed to load messages:", err.message);
      return c.json({ messages: [], threadId: base });
    }
  })

  .post("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), zValidator("json", ChatBodySchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const { messages } = c.req.valid("json");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

    const gameId = requestedGameId(c);
    if (!gameId) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const comparisonLaps = await loadComparisonLaps(id1, id2, gameId);
    if (!("lapA" in comparisonLaps)) return c.json({ error: comparisonLaps.error }, comparisonLaps.status);
    const { lapA, lapB } = comparisonLaps;
    const decisions = {
      lapA: resolveEligibilityDecision(lapA, "corner-trace"),
      lapB: resolveEligibilityDecision(lapB, "corner-trace"),
    };
    if (!isEligibilityUsable(decisions.lapA) || !isEligibilityUsable(decisions.lapB)) {
      return c.json(
        {
          error: [decisions.lapA, decisions.lapB]
            .filter((decision) => !isEligibilityUsable(decision))
            .map(eligibilityDecisionText)
            .join(" "),
          decisions,
        },
        422,
      );
    }
    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);
    const [findingGenerationA, findingGenerationB] = await loadStoredComparisonFindings(lapA, lapB);
    if (!findingGenerationA || !findingGenerationB) {
      return c.json(FindingGenerationBackfilling, 409);
    }
    const findingGenerationKey = compareFindingGenerationCacheKey([
      { lapId: lapA.id, receipt: findingGenerationA.receipt },
      { lapId: lapB.id, receipt: findingGenerationB.receipt },
    ]);
    const expectedFindingGenerationA = findingExpectationForLap(lapA, findingGenerationA.receipt);
    const expectedFindingGenerationB = findingExpectationForLap(lapB, findingGenerationB.receipt);
    const validateReceiptFence = async () => {
      const [currentA, currentB] = await loadStoredComparisonFindings(lapA, lapB);
      return (
        currentA !== null &&
        currentB !== null &&
        compareFindingGenerationCacheKey([
          { lapId: lapA.id, receipt: currentA.receipt },
          { lapId: lapB.id, receipt: currentB.receipt },
        ]) === findingGenerationKey
      );
    };
    if (!(await validateReceiptFence())) return c.json({ error: "Compared lap findings changed. Retry chat." }, 409);
    const findingsContext =
      buildFindingsContext(findingGenerationA.findings, { label: "Lap A" }) +
      buildFindingsContext(findingGenerationB.findings, { label: "Lap B" });
    const cachedA = await getAnalysis(id1, expectedFindingGenerationA);
    const cachedB = await getAnalysis(id2, expectedFindingGenerationB);
    if (!cachedA || !cachedB) {
      return c.json({ error: "Both laps must be analysed before chatting. Run analysis on each lap first." }, 400);
    }
    const identity = qualityCacheIdentityForComparison([lapA, lapB]);
    if (!identity) return c.json({ error: "Lap quality is unavailable or stale" }, 422);
    const requestContext = new RequestContext();
    requestContext.set(FINDING_RECEIPT_FENCE_CONTEXT_KEY, {
      kind: "comparison",
      gameId,
      cacheKey: findingGenerationKey,
      laps: [
        {
          lapId: lapA.id,
          generationId: findingGenerationA.receipt.generationId,
          contentHash: findingGenerationA.receipt.contentHash,
        },
        {
          lapId: lapB.id,
          generationId: findingGenerationB.receipt.generationId,
          contentHash: findingGenerationB.receipt.contentHash,
        },
      ],
    });

    const trackOrdinal = lapA.trackOrdinal ?? 0;
    const corners = await resolveLapCorners(trackOrdinal, lapA.gameId, lapA.telemetry);

    const comparison = compareLaps(lapA.telemetry, lapB.telemetry, corners, comparisonOptions(lapA, lapB));

    const settings = loadSettings();
    const systemPrompt = buildCompareChatSystemPrompt(
      {
        id: id1,
        lapNumber: lapA.lapNumber,
        lapTime: lapA.lapTime,
        isValid: lapA.isValid,
        carOrdinal: lapA.carOrdinal ?? undefined,
        trackOrdinal: lapA.trackOrdinal ?? undefined,
        gameId: lapA.gameId as GameId | undefined,
        quality: lapA.quality,
        eligibility: lapA.eligibility,
        qualityGeneration: lapA.qualityGeneration,
      },
      {
        id: id2,
        lapNumber: lapB.lapNumber,
        lapTime: lapB.lapTime,
        isValid: lapB.isValid,
        carOrdinal: lapB.carOrdinal ?? undefined,
        trackOrdinal: lapB.trackOrdinal ?? undefined,
        gameId: lapB.gameId as GameId | undefined,
        quality: lapB.quality,
        eligibility: lapB.eligibility,
        qualityGeneration: lapB.qualityGeneration,
      },
      comparison,
      cachedA.analysis,
      cachedB.analysis,
      settings.unit,
      settings.temperatureUnit,
      settings.language,
      findingsContext,
    );

    const chatProvider = settings.chatProvider;
    if (!chatProvider) {
      return c.json({ error: "No AI provider selected. Choose one in Settings → AI Chat." }, 400);
    }
    if (chatProvider === "gemini") {
      const key = await getSecret("gemini-api-key");
      if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Chat." }, 400);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      delete process.env.OPENAI_BASE_URL;
    } else if (chatProvider === "openai") {
      const key = await getSecret("openai-api-key");
      if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Chat." }, 400);
      process.env.OPENAI_API_KEY = key;
      delete process.env.OPENAI_BASE_URL;
    } else if (chatProvider === "local") {
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
      process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
    }

    const chatModelLabel = settings.chatModel || (chatProvider === "openai" ? "gpt-4o-mini" : chatProvider === "local" ? "local-model" : "gemini-flash-latest");

    const threadId = await resolveActiveThread(compareChatThreadId(id1, id2, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`));
    const turnStartedAt = Date.now();
    try {
      const stream = await compareChatAgent.stream([{ role: "system", content: systemPrompt }, ...messages], {
        memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
        requestContext,
        abortSignal: c.req.raw.signal,
        providerOptions: {
          openai: { reasoningEffort: "medium" },
          google: buildGoogleReasoningProviderOptions(chatModelLabel, settings.chatThinkingBudget) as never,
        },
      });

      return streamAgentTurnResponse({
        validateReceiptFence,
        agentStream: stream,
        originalMessages: messages,
        memory: getChatMemory(),
        threadId,
        turnStartedAt,
        abortSignal: c.req.raw.signal,
      });
    } catch (err: any) {
      console.error("[CompareChat] Stream failed:", err.message);
      return c.json({ error: err.message }, 500);
    }
  })

  .delete("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const gameId = requestedGameId(c);
    if (!gameId) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const comparisonLaps = await loadComparisonLapMetadata(id1, id2, gameId);
    if (!("lapA" in comparisonLaps)) return c.json({ error: comparisonLaps.error }, comparisonLaps.status);
    try {
      const memory = getChatMemory();
      const { lapA, lapB } = comparisonLaps;
      const [identity, findingGenerations] = await Promise.all([
        getCompareQualityIdentity(id1, id2),
        loadStoredComparisonFindings(lapA, lapB),
      ]);
      const [findingGenerationA, findingGenerationB] = findingGenerations;
      if (!identity || !findingGenerationA || !findingGenerationB) return c.json({ ok: true });
      const findingGenerationKey = compareFindingGenerationCacheKey([
        { lapId: lapA.id, receipt: findingGenerationA.receipt },
        { lapId: lapB.id, receipt: findingGenerationB.receipt },
      ]);
      const base = compareChatThreadId(id1, id2, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`);
      const gens = await listThreadGenerations(base);
      const ids = new Set(gens.map((g) => g.threadId));
      ids.add(base);
      for (const threadId of ids) {
        await memory.deleteThread(threadId);
      }
    } catch (err: any) {
      console.error("[CompareChat] Failed to clear thread:", err.message);
    }
    return c.json({ ok: true });
  });
