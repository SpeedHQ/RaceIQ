import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { IdParamSchema } from "../../shared/schemas";
import { GameIdSchema } from "../../shared/types";
import type { Tune } from "../../shared/types";
import {
  getLaps,
  getLapById,
  getLapsByIds,
  deleteLap,
  updateLapNotes,
  updateLapValidity,
  getCorners,
  saveCorners,
  getAnalysis,
  saveAnalysis,
  getCompareAnalysis,
  saveCompareAnalysis,
  deleteCompareAnalysis,
  getLapsRaw,
  getLapsForSession,
  setLapTuningExcluded,
} from "../db/queries";
import { buildLapsZip, lapsZipFilename, importLapsZip } from "../zip";
import { recordAction } from "../db/tuning-action-queries";
import { KNOWN_GAME_IDS } from "../../shared/types";
import { importSessionBin, detectGameIdFromBuffer } from "../import-session-bin";
import { analyzeLap } from "../../shared/lib/lap-insights";
import { downsampleLap, encodeLapTrace, type EncodedLapTrace } from "../../shared/stint-trace";
import { buildCompareInsightsBlock } from "../ai/insight-format";
import { assessLapRecording } from "../lap-quality";

// Toggle: set true to use native ACC lastSectorTime transitions in recheck instead of distance-fraction
const USE_NATIVE_ACC_SECTORS = false;
import { getTuneById as getDbTune } from "../db/tune-queries";
import { generateExport } from "../export";
import { compareLaps } from "../comparison";
import { detectCorners } from "../corner-detection";
import { getGame } from "../../shared/games/registry";

import type { GameId } from "../../shared/types";
import { loadSettings } from "../settings";
import { buildAnalystPrompt } from "../ai/analyst-prompt";
import { resolveTrack } from "../track-info";
import { computeLapSectors } from "../compute-lap-sectors";
import { getAnalystJsonSchema } from "../ai/schemas";
import {
  getChatMemory,
  chatThreadId,
  compareChatThreadId,
  CHAT_RESOURCE_ID,
  resolveActiveThread,
  generationThreadId,
  listThreadGenerations,
} from "../ai/chat-agent";
import { getSecret } from "../keystore";
import { deleteAnalysis as deleteAnalysisQuery } from "../db/queries";
import { tryGetGame } from "../../shared/games/registry";
import { gzip } from "zlib";
import { promisify } from "util";

const gzipAsync = promisify(gzip);
import { buildChatSystemPrompt } from "../ai/chat-prompt";
import { buildCompareChatSystemPrompt } from "../ai/compare-chat-prompt";
import { buildGoogleReasoningProviderOptions } from "../ai/google-provider-options";
import { streamAgentTurnResponse } from "../ai/agent-stream";
import { MessageList } from "@mastra/core/agent";
import { topCatalogReferences, normalizePacketSetup, getCatalogDisplayName } from "../ai/f1-setup-catalog";
import type { TelemetryPacket } from "../../shared/types";
import { buildInputsComparePrompt, InputsCompareSchema, type PromptSegment } from "../ai/inputs-compare-prompt";
// Dev uses the full Mastra instance (so Studio sees traces); prod tree-shakes
// the Mastra wrapper out. See `server/ai/agents.ts` for the switch.
import { lapAnalystAgent, lapChatAgent, compareEngineerAgent, compareChatAgent } from "../ai/agents";
import { buildGoogleProviderOptions, buildGoogleThinkingProviderOptions } from "../ai/google-provider-options";
import { toClientAiError } from "../ai/provider-error";
import { extractJson } from "../ai/extract-json";
import { resolveLapF1Setup } from "../ai/f1-setup-identity";

/**
 * Build the "F1 CURRENT SETUP + TOP-5 REFERENCE SETUPS" block appended to
 * the analyst prompt for F1 laps. The same data the
 * `compare-f1-setup-to-catalog` tool returns, but inline so local models
 * (Gemma 4) can answer in one shot instead of looping tool calls.
 */
function buildF1SetupReferenceBlock(carSetupJson: string | undefined, telemetry: TelemetryPacket[], trackOrdinal: number): string {
  const setup = resolveLapF1Setup({ carSetup: carSetupJson, telemetry });
  if (!setup || trackOrdinal < 0) return "";
  const current = normalizePacketSetup(setup as unknown as Record<string, unknown>);
  const refs = topCatalogReferences(trackOrdinal, 5, current);
  if (refs.length === 0) return "";

  const lines: string[] = [];
  lines.push(`\n\n--- F1 CURRENT SETUP + TOP-5 REFERENCE SETUPS (${getCatalogDisplayName(trackOrdinal) ?? "this track"}) ---`);
  lines.push("Use this data to populate setup[]. Cite rank/team/author per entry. Only propose steps within the step-cap rules.");
  lines.push("");
  lines.push("Current setup:");
  for (const [k, v] of Object.entries(current)) lines.push(`  ${k}: ${v}`);
  for (const r of refs) {
    lines.push("");
    lines.push(`Rank ${r.rank} — ${r.team} / ${r.author} — ${r.lapTime} (${r.weather}, ${r.inputDevice}):`);
    const deltas = Object.entries(r.delta ?? {});
    if (deltas.length === 0) {
      lines.push("  (identical to current setup)");
    } else {
      for (const [k, v] of deltas) {
        const sign = (v as number) > 0 ? "+" : "";
        lines.push(`  ${k}: ${current[k]} → ${(r.setup as Record<string, number>)[k]} (${sign}${v})`);
      }
    }
  }
  return lines.join("\n");
}

const CompareParamsSchema = z.object({
  id1: z.string().transform((val) => parseInt(val, 10)),
  id2: z.string().transform((val) => parseInt(val, 10)),
});

const LapsQuerySchema = z.object({
  gameId: GameIdSchema.optional(),
});

const AnalyseQuerySchema = z.object({
  regenerate: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  cacheOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int()),
});

/** Comma-separated id list in a query string → number[] (ignores junk/empties). */
const IdListSchema = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  );

const ExportZipQuerySchema = z.object({
  ids: IdListSchema,
  sessionIds: IdListSchema,
});

const ChatBodySchema = z.object({
  messages: z.array(z.any()),
});

export const lapRoutes = new Hono()
  // ── List laps ────────────────────────────────────────────────
  .get("/api/laps", zValidator("query", LapsQuerySchema), async (c) => {
    const { gameId } = c.req.valid("query");
    const lapList = await getLaps(gameId);
    return c.json(lapList);
  })

  // ── Bulk-delete by IDs (must precede :id routes) ────────────
  .post("/api/laps/bulk-delete", zValidator("json", BulkDeleteSchema), async (c) => {
    const { ids } = c.req.valid("json");
    let count = 0;
    for (const id of ids) {
      if (await deleteLap(id)) count++;
    }
    return c.json({ deleted: count });
  })

  // ── Export laps as a .zip (must precede :id routes) ─────────
  // Accepts any mix of explicit lap ids and whole sessions:
  //   /api/laps/export-zip?ids=1,2,3&sessionIds=7
  // Re-importable via POST /api/laps/import-zip.
  .get("/api/laps/export-zip", zValidator("query", ExportZipQuerySchema), async (c) => {
    const { ids, sessionIds } = c.req.valid("query");

    const lapIds = new Set<number>(ids ?? []);
    for (const sessionId of sessionIds ?? []) {
      for (const lap of await getLapsForSession(sessionId)) lapIds.add(lap.id);
    }
    if (lapIds.size === 0) return c.json({ error: "No laps matched the requested ids" }, 404);

    let built: Awaited<ReturnType<typeof buildLapsZip>>;
    try {
      built = await buildLapsZip([...lapIds]);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    const { bytes, manifest } = built;
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${lapsZipFilename(manifest)}"`);
    c.header("Content-Length", String(bytes.byteLength));
    return c.body(bytes.slice().buffer as ArrayBuffer);
  })

  // ── Import laps from a .zip produced by export-zip ───────────
  .post("/api/laps/import-zip", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing 'file' in multipart body" }, 400);
    if (!(file.name || "").toLowerCase().endsWith(".zip")) {
      return c.json({ error: "Expected a .zip file" }, 400);
    }

    try {
      const result = await importLapsZip(new Uint8Array(await file.arrayBuffer()));
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Failed to import zip: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
  })

  // ── Get single lap ──────────────────────────────────────────
  .get("/api/laps/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);

    // Compute sector times server-side
    let sectorTimes: { times: [number, number, number]; s1Idx: number; s2Idx: number; firstDist: number; lapDist: number } | null = null;
    const packets = lap.telemetry;
    if (packets.length >= 10 && lap.trackOrdinal != null) {
      const gameId = c.req.header("x-game-id") as GameId | undefined;
      const sectors = resolveTrack(gameId, lap.trackOrdinal).sectors;
      if (sectors?.s1End && sectors?.s2End) {
        const firstDist = packets[0].DistanceTraveled;
        const lastDist = packets[packets.length - 1].DistanceTraveled;
        const lapDist = lastDist - firstDist;
        if (lapDist > 0) {
          // Determine the best time source: CurrentLap if it progresses, else TimestampMS
          const lapProgression = packets[packets.length - 1].CurrentLap - packets[0].CurrentLap;
          const useTimestamp = lapProgression < 1; // CurrentLap unreliable (e.g. ACC with invalid iCurrentTime)
          const getTime = (i: number) => (useTimestamp ? (packets[i].TimestampMS - packets[0].TimestampMS) / 1000 : packets[i].CurrentLap - packets[0].CurrentLap);

          let s1Time = 0,
            s2Time = 0,
            s1Idx = -1,
            s2Idx = -1;
          for (let i = 0; i < packets.length; i++) {
            const frac = (packets[i].DistanceTraveled - firstDist) / lapDist;
            if (s1Idx < 0 && frac >= sectors.s1End) {
              s1Idx = i;
              s1Time = getTime(i);
            }
            if (s2Idx < 0 && frac >= sectors.s2End) {
              s2Idx = i;
              s2Time = getTime(i) - (s1Idx >= 0 ? getTime(s1Idx) : 0);
            }
          }
          const totalLapTime =
            lap.lapTime || (useTimestamp ? (packets[packets.length - 1].TimestampMS - packets[0].TimestampMS) / 1000 : packets[packets.length - 1].CurrentLap - packets[0].CurrentLap);
          let s3Time = totalLapTime - s1Time - s2Time;
          if (s3Time < 0) s3Time = 0;
          sectorTimes = { times: [s1Time, s2Time, s3Time], s1Idx, s2Idx, firstDist, lapDist };
        }
      }
    }

    // Precomputed lap insights — server-side so the client gets them in the
    // initial fetch instead of re-deriving on every render
    const insights = lap.gameId ? analyzeLap(packets, lap.gameId) : [];

    return c.json({ ...lap, sectorTimes, insights });
  })

  // ── Batch lap traces ────────────────────────────────────────
  // Downsampled stint traces for many laps in one call. Replaces the client
  // fetching full telemetry per lap (50 laps × ~80 fields) and reducing to a
  // trace locally: the server batch-decodes each session's laps in a single
  // pass (getLapsByIds), builds the ~14-channel LapTrace, and ships it as
  // base64 Float32 columns. downsampleLap only needs firstDist/lapDist, which
  // equal the packet-span fallback — so no sector computation is required and
  // the trace is byte-identical to the old client-side path.
  .post("/api/laps/traces", zValidator("json", z.object({ ids: z.array(z.number().int().positive()).max(200) })), async (c) => {
    const { ids } = c.req.valid("json");
    if (ids.length === 0) return c.json({ traces: [] as EncodedLapTrace[] });

    const laps = await getLapsByIds(ids);
    const traces: EncodedLapTrace[] = [];
    for (const lap of laps) {
      if (lap.telemetry.length === 0) continue;
      const trace = downsampleLap(lap.id, lap.lapNumber, lap.isValid, lap.telemetry, null);
      if (trace) traces.push(encodeLapTrace(trace));
    }
    return c.json({ traces });
  })

  // ── Export lap telemetry as text ────────────────────────────
  .get("/api/laps/:id/export", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);
    const packets = lap.telemetry;
    if (packets.length === 0) return c.json({ error: "No telemetry data" }, 400);
    const exportText = generateExport(lap, packets);
    return c.text(exportText);
  })

  // ── Export raw session capture (.bin) containing this lap ────
  // The raw capture is stored per-session, so this hands back the whole
  // session .bin (meta frame + every frame). Re-importable via POST
  // /api/laps/import, which re-runs the pipeline to rebuild all laps.
  .get("/api/laps/:id/export-bin", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await getLapsRaw([id]);
    if (!row) return c.json({ error: "Lap not found" }, 404);
    if (!row.rawFile) return c.json({ error: "No raw capture available for this lap" }, 409);

    const file = Bun.file(row.rawFile);
    if (!(await file.exists())) return c.json({ error: "Raw capture file is missing on disk" }, 410);
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (!row.rawFile.endsWith(".gz")) {
      bytes = new Uint8Array(await gzipAsync(Buffer.from(bytes)));
    }

    const trackName = tryGetGame(row.gameId)?.getTrackName?.(row.trackOrdinal ?? -1);
    const slug = (trackName || `track${row.trackOrdinal ?? 0}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    // Filename MUST start with `<gameId>-` so re-import can detect the game.
    const filename = `${row.gameId}-${slug}-session${row.sessionId}.bin.gz`;

    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    c.header("Content-Length", String(bytes.byteLength));
    return c.body(bytes);
  })

  // ── Import a raw session capture (.bin) ─────────────────────
  // Feeds an uploaded session .bin through the full pipeline so its laps land
  // in the DB as a fresh session. GameId is detected from the frame content
  // (each adapter's canHandle()), not the uploaded filename.
  .post("/api/laps/import", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing 'file' in multipart body" }, 400);

    const uploadName = file.name || "upload.bin";
    const lower = uploadName.toLowerCase();
    if (!lower.endsWith(".bin") && !lower.endsWith(".bin.gz")) {
      return c.json({ error: "Expected a .bin or .bin.gz file" }, 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const gameId = detectGameIdFromBuffer(bytes);
    if (!gameId) {
      return c.json(
        { error: `Could not detect game from "${uploadName}" — no recognized frame format found. Supported games: ${KNOWN_GAME_IDS.join(", ")}.` },
        400
      );
    }

    try {
      const { packetCount, laps } = await importSessionBin(bytes, gameId);
      if (packetCount === 0) return c.json({ error: "No telemetry packets found in file" }, 400);
      return c.json({
        ok: true,
        gameId,
        routePrefix: getGame(gameId).routePrefix,
        packetCount,
        imported: laps.length,
        laps,
      });
    } catch (err: any) {
      console.error("[Import] Failed:", err?.message);
      return c.json({ error: "Failed to import file", details: String(err?.message ?? err) }, 500);
    }
  })

  // ── AI analysis ─────────────────────────────────────────────
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
        parsedTune = {
          ...dbTune,
          strengths: dbTune.strengths ? JSON.parse(dbTune.strengths) : [],
          weaknesses: dbTune.weaknesses ? JSON.parse(dbTune.weaknesses) : [],
          bestTracks: dbTune.bestTracks ? JSON.parse(dbTune.bestTracks) : [],
          strategies: dbTune.strategies ? JSON.parse(dbTune.strategies) : [],
          settings: JSON.parse(dbTune.settings),
        } as Tune;
      }
    }

    // Curated track data (#84): named segments with their official turn
    // numbers, and this game's sector boundaries. Game-specific — each game's
    // centerline has its own lap fractions.
    const track = resolveTrack(lap.gameId, lap.trackOrdinal);
    const segments = track.segments;

    // Sector times, split on those boundaries, so the model can attribute a
    // slow sector to the corners it actually covers.
    let sectors: { times: { s1: number; s2: number; s3: number }; s1End: number; s2End: number } | undefined;
    if (track.sectors.s1End && track.sectors.s2End && lap.gameId && lap.trackOrdinal != null) {
      try {
        const times = await computeLapSectors(lap.trackOrdinal, lap.gameId as GameId, lap.telemetry, lap.lapTime);
        if (times) sectors = { times, s1End: track.sectors.s1End, s2End: track.sectors.s2End };
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
  })

  // ── Chat: get messages ───────────────────────────────────────
  .get("/api/laps/:id/chat", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    try {
      const memory = getChatMemory();
      const base = chatThreadId(id);
      const genParam = Number(c.req.query("gen"));
      const threadId = Number.isInteger(genParam) && genParam >= 1
        ? generationThreadId(base, genParam)
        : await resolveActiveThread(base);
      const thread = await memory.getThreadById({ threadId });
      if (!thread) return c.json({ messages: [] });
      const result = await memory.recall({ threadId });
      const raw = result.messages ?? [];

      const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
      list.add(raw, "memory");
      const uiMessages = list.get.all.aiV5
        .ui()
        .filter((m) => m.role === "user" || m.role === "assistant");

      return c.json({ messages: uiMessages });
    } catch (err: any) {
      console.error("[Chat] Failed to load messages:", err.message);
      return c.json({ messages: [] });
    }
  })

  // ── Chat: send message (streaming) ─────────────────────────
  .post("/api/laps/:id/chat", zValidator("param", IdParamSchema), zValidator("json", ChatBodySchema), async (c) => {
    const { id } = c.req.valid("param");
    const { messages } = c.req.valid("json");

    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);
    if (lap.telemetry.length === 0) return c.json({ error: "No telemetry data" }, 400);

    const settings = loadSettings();
    const trackOrdinal = lap.trackOrdinal ?? 0;
    // Curated corners from `track_corners` first; fall back to telemetry
    // detection (T1..Tn) when the track has no entries — lets the client
    // resolve "T13" card clicks to the correct position instead of lap start.
    let corners = trackOrdinal > 0 && lap.gameId ? await getCorners(trackOrdinal, lap.gameId) : [];
    if (corners.length === 0 && lap.telemetry.length > 0) {
      corners = detectCorners(lap.telemetry);
    }

    // Load tune if linked
    let parsedTune: Tune | undefined;
    if (lap.tuneId) {
      const dbTune = await getDbTune(lap.tuneId);
      if (dbTune) {
        parsedTune = {
          ...dbTune,
          strengths: dbTune.strengths ? JSON.parse(dbTune.strengths) : [],
          weaknesses: dbTune.weaknesses ? JSON.parse(dbTune.weaknesses) : [],
          bestTracks: dbTune.bestTracks ? JSON.parse(dbTune.bestTracks) : [],
          strategies: dbTune.strategies ? JSON.parse(dbTune.strategies) : [],
          settings: JSON.parse(dbTune.settings),
        } as Tune;
      }
    }

    // Load cached analysis for context
    const cached = await getAnalysis(id);
    const analysisJson = cached?.analysis;

    // Build chat prompt
    const systemPrompt = buildChatSystemPrompt(lap, lap.telemetry, corners, settings.unit, settings.temperatureUnit, parsedTune, analysisJson, settings.language);

    // Provider/key/model plumbing — inlined from the old startChatStream
    // helper (removed, was the NDJSON transport's shared provider setup)
    // since this route now speaks the AI SDK v5 UI-message-stream
    // protocol instead).
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

    const chatModelLabel = settings.chatModel
      || (chatProvider === "openai"
        ? "gpt-4o-mini"
        : chatProvider === "local"
          ? "local-model"
          : "gemini-flash-latest");

    const threadId = await resolveActiveThread(chatThreadId(id));
    const turnStartedAt = Date.now();
    try {
      const stream = await lapChatAgent.stream(
        [{ role: "system", content: systemPrompt }, ...messages],
        {
          memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
          providerOptions: {
            openai: { reasoningEffort: "medium" },
            google: buildGoogleReasoningProviderOptions(chatModelLabel, settings.chatThinkingBudget) as never,
          },
        },
      );

      return streamAgentTurnResponse({
        agentStream: stream,
        originalMessages: messages,
        memory: getChatMemory(),
        threadId,
        turnStartedAt,
      });
    } catch (err: any) {
      console.error("[Chat] Stream failed:", err.message);
      return c.json({ error: err.message }, 500);
    }
  })

  // ── Chat: clear messages ───────────────────────────────────
  .delete("/api/laps/:id/chat", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    try {
      const memory = getChatMemory();
      const base = chatThreadId(id);
      const gens = await listThreadGenerations(base);
      const ids = new Set(gens.map((g) => g.threadId));
      ids.add(base);
      for (const threadId of ids) {
        await memory.deleteThread(threadId);
      }
    } catch (err: any) {
      console.error("[Chat] Failed to clear thread:", err.message);
    }
    // Also clear cached analysis
    try {
      await deleteAnalysisQuery(id);
    } catch (err: any) {
      console.error("[Chat] Failed to clear analysis:", err.message);
    }
    return c.json({ ok: true });
  })

  // ── Update lap notes ───────────────────────────────────────
  .patch("/api/laps/:id/notes", zValidator("param", IdParamSchema), zValidator("json", z.object({ notes: z.string().nullable() })), async (c) => {
    const { id } = c.req.valid("param");
    await updateLapNotes(id, c.req.valid("json").notes);
    return c.json({ ok: true });
  })

  // ── Manual lap exclusion from tuning aggregate (setup-engineer-flow §Phase 7) ──
  .post(
    "/api/laps/:id/tuning-excluded",
    zValidator("param", IdParamSchema),
    zValidator("json", z.object({ excluded: z.boolean() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { excluded } = c.req.valid("json");
      const { ok, prev, tuningSessionId } = await setLapTuningExcluded(id, excluded);
      if (!ok) return c.json({ error: "Lap not found" }, 404);

      // Best-effort: an action-log write failure must not fail the request —
      // the lap flag is already committed. Only log when the lap is linked
      // to a tuning session (laps outside a tuning session have nothing to undo into).
      if (tuningSessionId != null) {
        try {
          await recordAction(tuningSessionId, "set-lap-excluded", { lapId: id, prevExcluded: prev });
        } catch (err: any) {
          console.error("[LapRoutes] Failed to log set-lap-excluded action:", err?.message);
        }
      }

      return c.json({ ok: true, lapId: id, excluded });
    },
  )

  // ── Recheck lap validity (dev tool) ─────────────────────────
  .post("/api/laps/:id/recheck", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);

    const quality = assessLapRecording(lap.telemetry, lap.lapTime);

    // Recompute sector times
    const packets = lap.telemetry;
    let sectors: { s1: number; s2: number; s3: number } | null = null;
    if (packets.length >= 50) {
      const startDist = packets[0].DistanceTraveled;
      const lapDist = packets[packets.length - 1].DistanceTraveled - startDist;
      if (lapDist >= 100) {
        const gameId = lap.gameId as GameId | undefined;
        let s1 = 0,
          s2 = 0;

        if (USE_NATIVE_ACC_SECTORS && gameId === "acc") {
          // Replay native sector transitions from stored packets (mirrors live tracker)
          let prevIdx = packets[0].acc?.currentSectorIndex ?? 0;
          for (const p of packets) {
            if (!p.acc) continue;
            const idx = p.acc.currentSectorIndex;
            const t = p.acc.lastSectorTime / 1000;
            if (idx !== prevIdx && t > 0) {
              if (prevIdx === 0) s1 = t;
              else if (prevIdx === 1) s2 = t;
              prevIdx = idx;
            }
          }
        }

        if (s1 === 0 || s2 === 0) {
          const _gameId = c.req.header("x-game-id") as GameId | undefined;
          const { s1End, s2End } = resolveTrack(_gameId, lap.trackOrdinal).sectors;

          let sector = 0,
            sectorStart = packets[0].CurrentLap;
          s1 = 0;
          s2 = 0;
          for (const p of packets) {
            const frac = (p.DistanceTraveled - startDist) / lapDist;
            const expected = frac < s1End ? 0 : frac < s2End ? 1 : 2;
            if (expected > sector) {
              const t = p.CurrentLap - sectorStart;
              if (sector === 0) s1 = t;
              else if (sector === 1) s2 = t;
              sectorStart = p.CurrentLap;
              sector = expected;
            }
          }
        }

        if (s1 > 0 && s2 > 0) {
          const s3 = lap.lapTime - s1 - s2;
          if (s3 > 0) sectors = { s1, s2, s3 };
        }
      }
    }

    await updateLapValidity(id, quality.valid, quality.valid ? null : quality.reason, sectors);
    return c.json({ id, valid: quality.valid, reason: quality.reason, sectors });
  })

  // ── Delete single lap ───────────────────────────────────────
  .delete("/api/laps/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const deleted = await deleteLap(id);
    if (!deleted) return c.json({ error: "Lap not found" }, 404);
    return c.json({ success: true });
  })

  // ── Compare two laps ───────────────────────────────────────
  .get("/api/laps/:id1/compare/:id2", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

    const lapA = await getLapById(id1);
    if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);

    const lapB = await getLapById(id2);
    if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);

    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);

    const trackOrdinal = lapA.trackOrdinal ?? 0;
    let corners: Awaited<ReturnType<typeof getCorners>> = [];
    try {
      corners = lapA.gameId ? await getCorners(trackOrdinal, lapA.gameId) : [];
    } catch {
      /* corners optional */
    }

    if (corners.length === 0 && trackOrdinal > 0) {
      const detected = detectCorners(lapA.telemetry);
      if (detected.length > 0 && lapA.gameId) {
        try {
          await saveCorners(trackOrdinal, detected, lapA.gameId, true);
          corners = detected;
        } catch {
          // Race / unique constraint — corners optional, fall back to in-memory only
          corners = detected;
        }
      }
    }

    const result = compareLaps(lapA.telemetry, lapB.telemetry, corners);

    return c.json({
      lapA: {
        lapNumber: lapA.lapNumber,
        lapTime: lapA.lapTime,
        isValid: lapA.isValid,
        trackOrdinal: lapA.trackOrdinal,
        carOrdinal: lapA.carOrdinal,
      },
      lapB: {
        lapNumber: lapB.lapNumber,
        lapTime: lapB.lapTime,
        isValid: lapB.isValid,
        trackOrdinal: lapB.trackOrdinal,
        carOrdinal: lapB.carOrdinal,
      },
      traces: {
        distance: result.distances,
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
      telemetryA: lapA.telemetry,
      telemetryB: lapB.telemetry,
      gameId: lapA.gameId,
    });
  })

  // ── Inputs comparison analysis ─────────────────────────────
  .post("/api/laps/:id1/compare/:id2/inputs-analyse", zValidator("param", CompareParamsSchema), zValidator("query", AnalyseQuerySchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const { regenerate, cacheOnly } = c.req.valid("query");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

    // Cache lookup first
    if (!regenerate) {
      const cached = await getCompareAnalysis(id1, id2, "inputs");
      if (cached) {
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
        });
      }
      if (cacheOnly) return c.json({ analysis: null, cached: false });
    }

    const lapA = await getLapById(id1);
    if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);
    const lapB = await getLapById(id2);
    if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);
    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);

    const trackOrdinal = lapA.trackOrdinal ?? 0;
    let corners: Awaited<ReturnType<typeof getCorners>> = [];
    try {
      corners = lapA.gameId ? await getCorners(trackOrdinal, lapA.gameId) : [];
    } catch {
      /* corners optional */
    }

    const comparison = compareLaps(lapA.telemetry, lapB.telemetry, corners);

    const settings = loadSettings();

    // Named track segments (corners + straights) for the per-segment breakdown.
    // Game-specific, and carrying the official turn numbers so the breakdown
    // names corners the same way the map and the track guide do.
    const segments: PromptSegment[] | null =
      resolveTrack(lapA.gameId, lapA.trackOrdinal).segments.map((s) => ({
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
      },
      {
        lapNumber: lapB.lapNumber,
        lapTime: lapB.lapTime,
        isValid: lapB.isValid,
        carOrdinal: lapB.carOrdinal ?? undefined,
        trackOrdinal: lapB.trackOrdinal ?? undefined,
        gameId: lapB.gameId as GameId | undefined,
      },
      comparison,
      segments,
      undefined,
      buildCompareInsightsBlock("Lap A", lapA.telemetry, lapA.gameId as GameId | undefined) +
        buildCompareInsightsBlock("Lap B", lapB.telemetry, lapB.gameId as GameId | undefined),
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
          google: buildGoogleThinkingProviderOptions(
            settings.aiModel || "gemini-flash-latest",
            settings.aiThinkingBudget,
          ) as never,
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
      await saveCompareAnalysis(id1, id2, analysisJson, usage, "inputs");
      return c.json({ analysis: analysisJson, cached: false, usage });
    } catch (err: any) {
      console.error("[InputsCompare] Failed:", err.message);
      return c.json({ error: err.message }, err.message.includes("timed out") ? 504 : 500);
    }
  })

  // ── Inputs comparison: clear cached analysis ───────────────
  .delete("/api/laps/:id1/compare/:id2/inputs-analyse", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    try {
      await deleteCompareAnalysis(id1, id2, "inputs");
    } catch (err: any) {
      console.error("[InputsCompare] Failed to clear:", err.message);
    }
    return c.json({ ok: true });
  })

  // ── Compare chat: get messages ─────────────────────────────
  .get("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    try {
      const memory = getChatMemory();
      const base = compareChatThreadId(id1, id2);
      const genParam = Number(c.req.query("gen"));
      const threadId = Number.isInteger(genParam) && genParam >= 1
        ? generationThreadId(base, genParam)
        : await resolveActiveThread(base);
      const thread = await memory.getThreadById({ threadId });
      if (!thread) return c.json({ messages: [] });
      const result = await memory.recall({ threadId });
      const raw = result.messages ?? [];

      const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
      list.add(raw, "memory");
      const uiMessages = list.get.all.aiV5
        .ui()
        .filter((m) => m.role === "user" || m.role === "assistant");

      return c.json({ messages: uiMessages });
    } catch (err: any) {
      console.error("[CompareChat] Failed to load messages:", err.message);
      return c.json({ messages: [] });
    }
  })

  // ── Compare chat: send message (streaming) ────────────────
  .post("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), zValidator("json", ChatBodySchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const { messages } = c.req.valid("json");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

    const lapA = await getLapById(id1);
    if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);
    const lapB = await getLapById(id2);
    if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);
    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);

    const cachedA = await getAnalysis(id1);
    const cachedB = await getAnalysis(id2);
    if (!cachedA || !cachedB) {
      return c.json({ error: "Both laps must be analysed before chatting. Run analysis on each lap first." }, 400);
    }

    const trackOrdinal = lapA.trackOrdinal ?? 0;
    let corners: Awaited<ReturnType<typeof getCorners>> = [];
    try {
      corners = lapA.gameId ? await getCorners(trackOrdinal, lapA.gameId) : [];
    } catch {
      /* corners optional */
    }

    const comparison = compareLaps(lapA.telemetry, lapB.telemetry, corners);

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
      },
      {
        id: id2,
        lapNumber: lapB.lapNumber,
        lapTime: lapB.lapTime,
        isValid: lapB.isValid,
        carOrdinal: lapB.carOrdinal ?? undefined,
        trackOrdinal: lapB.trackOrdinal ?? undefined,
        gameId: lapB.gameId as GameId | undefined,
      },
      comparison,
      cachedA.analysis,
      cachedB.analysis,
      settings.unit,
      settings.temperatureUnit,
      settings.language,
      buildCompareInsightsBlock("Lap A", lapA.telemetry, lapA.gameId as GameId | undefined) +
        buildCompareInsightsBlock("Lap B", lapB.telemetry, lapB.gameId as GameId | undefined),
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

    const chatModelLabel = settings.chatModel
      || (chatProvider === "openai"
        ? "gpt-4o-mini"
        : chatProvider === "local"
          ? "local-model"
          : "gemini-flash-latest");

    const threadId = await resolveActiveThread(compareChatThreadId(id1, id2));
    const turnStartedAt = Date.now();
    try {
      const stream = await compareChatAgent.stream(
        [{ role: "system", content: systemPrompt }, ...messages],
        {
          memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
          providerOptions: {
            openai: { reasoningEffort: "medium" },
            google: buildGoogleReasoningProviderOptions(chatModelLabel, settings.chatThinkingBudget) as never,
          },
        },
      );

      return streamAgentTurnResponse({
        agentStream: stream,
        originalMessages: messages,
        memory: getChatMemory(),
        threadId,
        turnStartedAt,
      });
    } catch (err: any) {
      console.error("[CompareChat] Stream failed:", err.message);
      return c.json({ error: err.message }, 500);
    }
  })

  // ── Compare chat: clear messages ───────────────────────────
  .delete("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    try {
      const memory = getChatMemory();
      const base = compareChatThreadId(id1, id2);
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
  })

  // ── Delete ALL laps ─────────────────────────────────────────
  .delete("/api/laps", async (c) => {
    const laps = await getLaps();
    let count = 0;
    for (const lap of laps) {
      if (await deleteLap(lap.id)) count++;
    }
    return c.json({ deleted: count });
  });
