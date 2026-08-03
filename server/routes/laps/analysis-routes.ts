import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { IdParamSchema } from "@shared/platform/http/route-schemas";
import type { GameId } from "../../../shared/games/ids";
import type { Tune } from "../../../shared/racing/tuning/types";
import { getGame } from "../../../shared/games/registry";
import { getLapById } from "../../db/lap-read-queries";
import { getAnalysis, saveAnalysis } from "../../db/analysis-queries";
import { getCorners } from "../../db/track-queries";
import { getTuneById as getDbTune } from "../../db/tune-queries";
import { detectCorners } from "../../lap-analysis/corners";
import { computeNativeSectorTimeline, computeLapSectors } from "../../lap-analysis/sectors";
import { loadSettings } from "../../runtime/config/settings";
import { resolveTrack } from "../../tracks/info";
import { buildAnalystPrompt } from "../../ai/analyst-prompt";
import { lapAnalystAgent } from "../../ai/agents";
import { getAnalystJsonSchema } from "../../ai/schemas";
import { buildGoogleProviderOptions } from "../../ai/google-provider-options";
import { toClientAiError } from "../../ai/provider-error";
import { extractJson } from "../../ai/extract-json";
import { getSecret } from "../../runtime/platform/keystore";
import { AnalyseQuerySchema, buildF1SetupReferenceBlock } from "./support";
import { parseTuneRow } from "../tune-shared";

export const analysisRoutes = new Hono()
  .post("/api/laps/:id/analyse", zValidator("param", IdParamSchema), zValidator("query", AnalyseQuerySchema), async (c) => {
    const { id } = c.req.valid("param");
    const { regenerate, cacheOnly } = c.req.valid("query");

    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);
    if (lap.telemetry.length === 0) return c.json({ error: "No telemetry data" }, 400);

    const trackOrdinal = lap.trackOrdinal ?? 0;
    // Curated corners from `track_corners` first; fall back to telemetry
    // detection (T1..Tn) when the track has no entries — lets the client
    // resolve "T13" card clicks to the correct position instead of lap start.
    let corners = trackOrdinal > 0 && lap.gameId ? await getCorners(trackOrdinal, lap.gameId) : [];
    if (corners.length === 0 && lap.telemetry.length > 0) {
      corners = detectCorners(lap.telemetry);
    }

    // Compute corner fracs for client-side track highlighting
    const totalDist = lap.telemetry.length > 1 ? lap.telemetry[lap.telemetry.length - 1].DistanceTraveled - lap.telemetry[0].DistanceTraveled : 1;
    const firstDist = lap.telemetry[0]?.DistanceTraveled ?? 0;
    const cornerFracs = corners.map((c) => ({
      label: c.label,
      startFrac: Math.max(0, (c.distanceStart - firstDist) / totalDist),
      endFrac: Math.min(1, (c.distanceEnd - firstDist) / totalDist),
    }));

    // `hasTune` tells the UI whether the analysis had authoritative setup data.
    // Forza laps: a linked `tuneId`. F1 laps: the per-lap `carSetup` snapshot
    // (fetched by the compare-f1-setup-to-catalog tool, not injected into
    // the prompt). Without this, the "No tune data linked" banner would fire
    // on every F1 analysis even though the tool gives the model the setup.
    const hasTune = !!lap.tuneId || (lap.gameId === "f1-2025" && !!lap.carSetup);

    if (!regenerate) {
      const cached = await getAnalysis(id);
      // Guard: only serve caches whose payload is valid JSON. Earlier runs
      // (pre-validation) could persist empty strings or truncated output —
      // those would otherwise get stuck replaying the broken text forever.
      let cachedIsValid = false;
      if (cached?.analysis) {
        try {
          JSON.parse(cached.analysis);
          cachedIsValid = true;
        } catch {
          cachedIsValid = false;
        }
      }
      if (cached && cachedIsValid) {
        return c.json({
          analysis: cached.analysis,
          cached: true,
          usage: {
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens,
            costUsd: cached.costUsd,
            durationMs: cached.durationMs,
            model: cached.model,
          },
          cornerFracs,
          hasTune,
        });
      }
      if (cacheOnly) {
        return c.json({ analysis: null, cached: false, cornerFracs, hasTune });
      }
    }
    const settings = loadSettings();

    let parsedTune: Tune | undefined;
    if (lap.tuneId) {
      const dbTune = await getDbTune(lap.tuneId);
      if (dbTune) {
        parsedTune = parseTuneRow(dbTune) as unknown as Tune;
      }
    }

    // Curated track data (#84): named segments with their official turn
    // numbers, and this game's sector boundaries. Game-specific — each game's
    // centerline has its own lap fractions.
    const track = resolveTrack(lap.gameId, lap.trackOrdinal);
    const segments = track.segments;

    // Sector times, split on those boundaries, so the model can attribute a
    // slow sector to the corners it actually covers.
    let sectors: { times: number[]; sectorStarts: number[] } | undefined;
    if (lap.gameId && lap.trackOrdinal != null) {
      try {
        const game = getGame(lap.gameId);
        if (game.nativeSectors && game.getNativeSectorLayout) {
          const timeline = computeNativeSectorTimeline(
            lap.telemetry,
            lap.lapTime,
            game.getNativeSectorLayout,
          );
          if (timeline) {
            sectors = {
              times: timeline.times,
              sectorStarts: timeline.sectorStarts,
            };
          }
        } else if (track.sectors.s1End && track.sectors.s2End) {
          const times = await computeLapSectors(
            lap.trackOrdinal,
            lap.gameId as GameId,
            lap.telemetry,
            lap.lapTime,
          );
          if (times) {
            sectors = {
              times,
              sectorStarts: [
                0,
                track.sectors.s1End,
                track.sectors.s2End,
              ],
            };
          }
        }
      } catch {
        /* sector times are optional context */
      }
    }

    let prompt = buildAnalystPrompt(lap, lap.telemetry, corners, settings.unit, settings.temperatureUnit, parsedTune, segments, undefined, settings.language, sectors);
    if (lap.gameId === "f1-2025") {
      prompt += buildF1SetupReferenceBlock(lap.carSetup, lap.telemetry, lap.trackOrdinal ?? -1);
    }

    // Bridge keystore secret → env var so Mastra / AI SDK providers can resolve it.
    // The Mastra lap-analyst agent reads the provider from settings via `getMastraModelId`.
    const analystProvider = settings.aiProvider;
    if (!analystProvider) {
      return c.json({ error: "No AI provider selected. Choose one in Settings → AI Analysis." }, 400);
    }
    if (analystProvider === "openai") {
      const key = await getSecret("openai-api-key");
      if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Analysis." }, 400);
      process.env.OPENAI_API_KEY = key;
    } else if (analystProvider === "local") {
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
      process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
    } else {
      const key = await getSecret("gemini-api-key");
      if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Analysis." }, 400);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
    }

    // Analyse returns a heartbeat-style NDJSON stream: `ping` every ~200s
    // to keep Bun's 255s idleTimeout alive for slow local models, then a
    // single `result` (or `error`) event at the end. The client doesn't
    // render intermediate status — it just waits for the result.
    const modelLabel = settings.aiModel
      || (analystProvider === "openai"
        ? "gpt-4o-mini"
        : analystProvider === "local"
          ? "local-model"
          : "gemini-flash-latest");
    const startedAt = Date.now();
    const encoder = new TextEncoder();
    const writeEvent = (c: ReadableStreamDefaultController, obj: unknown) => {
      try {
        c.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      } catch {
        /* closed */
      }
    };
    const hideTools = analystProvider === "local";

    const readable = new ReadableStream({
      async start(controller) {
        const keepAlive = setInterval(() => {
          writeEvent(controller, { type: "ping" });
        }, 200_000);
        try {
          const result = await lapAnalystAgent.generate(prompt, {
            maxSteps: 5,
            ...(hideTools ? { activeTools: [] as never[] } : {}),
            modelSettings: { maxOutputTokens: 8192, temperature: 0 },
            providerOptions: {
              openai: {
                reasoningEffort: "medium",
                responseFormat: {
                  type: "json_schema",
                  jsonSchema: {
                    name: "analyst_output",
                    strict: true,
                    schema: getAnalystJsonSchema() as Record<string, never>,
                  },
                } as never,
              },
              google: buildGoogleProviderOptions(modelLabel, getAnalystJsonSchema() as Record<string, unknown>, settings.aiThinkingBudget) as never,
            },
          });
          const rawText = typeof result.text === "string" ? result.text : "";
          let text = rawText;
          const durationMs = Date.now() - startedAt;
          let validJson = false;
          try {
            text = extractJson(rawText);
            validJson = true;
          } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.warn(`[analyse] model output is not valid JSON (${msg}) — skipping cache write`);
          }
          const rawUsage = (result.usage ?? {}) as Record<string, unknown>;
          const n = (k: string) => (typeof rawUsage[k] === "number" ? (rawUsage[k] as number) : 0);
          const usage = {
            inputTokens: n("inputTokens") || n("promptTokens"),
            outputTokens: n("outputTokens") || n("completionTokens"),
            costUsd: 0,
            durationMs,
            model: modelLabel,
          };
          if (!validJson) {
            writeEvent(controller, {
              type: "error",
              message: "Model produced invalid JSON. Not cached. Try again or switch model.",
            });
          } else {
            await saveAnalysis(id, text, usage);
            writeEvent(controller, {
              type: "result",
              analysis: text,
              cached: false,
              usage,
              cornerFracs,
              hasTune,
            });
          }
        } catch (err: unknown) {
          const aiError = toClientAiError(err);
          console.error("[AI] Analysis failed:", aiError.message);
          writeEvent(controller, { type: "error", ...aiError });
        } finally {
          clearInterval(keepAlive);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "Transfer-Encoding": "chunked",
      },
    });
  });
