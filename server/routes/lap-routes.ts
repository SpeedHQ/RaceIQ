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
  setLapExperimentExcluded,
} from "../db/queries";
import { buildLapsZip, lapsZipFilename, importLapsZip } from "../zip";
import { recordAction } from "../db/experiment-action-queries";
import { KNOWN_GAME_IDS } from "../../shared/types";
import {
  importSessionBin,
  detectGameIdFromBuffer,
} from "../import-session-bin";
import {
  cancelStagedIbt,
  commitStagedIbt,
  IbtImportError,
  stageIbtUpload,
} from "../import-ibt";
import { importMotec, resolveMotecTarget } from "../motec/import";
import { getMotecTargets, initMotecTargets } from "../motec/targets";
import { analyzeLap } from "../../shared/lib/lap-insights";
import {
  downsampleLap,
  encodeLapTrace,
  type EncodedLapTrace,
} from "../../shared/stint-trace";
import { buildCompareInsightsBlock } from "../ai/insight-format";
import { assessLapRecording } from "../lap-quality";

import { getTuneById as getDbTune } from "../db/tune-queries";
import { generateExport } from "../export";
import { compareLaps } from "../comparison";
import { detectCorners } from "../corner-detection";
import type { Corner } from "../corner-detection";
import { getGame } from "../../shared/games/registry";

import type { GameId } from "../../shared/types";
import { loadSettings } from "../settings";
import { buildAnalystPrompt } from "../ai/analyst-prompt";
import { resolveTrack } from "../track-info";
import {
  computeNativeSectorTimeline,
  computeLapSectors,
} from "../compute-lap-sectors";
import { getAnalystJsonSchema } from "../ai/schemas";
import {
  getChatMemory,
  chatThreadId,
  compareChatThreadId,
  CHAT_RESOURCE_ID,
  chatMemoryOptions,
  resolveActiveThread,
  generationThreadId,
  buildChatExport,
  chatMemoryMessagesToUiMessages,
  getChatSystemPrompt,
  ensureSystemPrompt,
  deleteChatLineage,
} from "../ai/chat-agent";
import { getSecret } from "../keystore";
import { deleteAnalysis as deleteAnalysisQuery } from "../db/queries";
import { tryGetGame } from "../../shared/games/registry";
import { gzip } from "zlib";
import { promisify } from "util";

const gzipAsync = promisify(gzip);
import { buildChatSystemPrompt } from "../ai/chat-prompt";
import { buildCompareChatContext } from "../ai/compare-chat-prompt";
import { buildGoogleReasoningProviderOptions } from "../ai/google-provider-options";
import { startDetachedAgentTurn } from "../ai/agent-stream";
import {
  CHAT_TURN_CONTEXT_KEY,
  compareChatToolChoice,
  lapChatToolChoice,
  sanitizeChatHistoryMessages,
} from "../ai/chat-message-context";
import { reserveChatRun, buildReplayStream, finishRun } from "../ai/chat-run-registry";
import { createUIMessageStreamResponse } from "ai";
import { RequestContext } from "@mastra/core/request-context";
import {
  topCatalogReferences,
  normalizePacketSetup,
  getCatalogDisplayName,
} from "../ai/f1-setup-catalog";
import type { TelemetryPacket } from "../../shared/types";
import {
  buildInputsComparePrompt,
  InputsCompareSchema,
  type PromptSegment,
} from "../ai/inputs-compare-prompt";
// Dev uses the full Mastra instance (so Studio sees traces); prod tree-shakes
// the Mastra wrapper out. See `server/ai/agents.ts` for the switch.
import {
  lapAnalystAgent,
  lapChatAgent,
  compareEngineerAgent,
  compareChatAgent,
} from "../ai/agents";
import {
  buildGoogleProviderOptions,
  buildGoogleThinkingProviderOptions,
} from "../ai/google-provider-options";
import { formatClientAiErrorMessage, toClientAiError } from "../ai/provider-error";
import { extractJson } from "../ai/extract-json";
import { resolveLapF1Setup } from "../ai/f1-setup-identity";
import { generateLapAnalysis } from "../ai/generate-lap-analysis";
import {
  beginAnalysisRun,
  finishAnalysisRun,
  getAnalysisRun,
} from "../ai/analysis-run-registry";

/**
 * Build the "F1 CURRENT SETUP + TOP-5 REFERENCE SETUPS" block appended to
 * the analyst prompt for F1 laps. The same data the
 * `compare-f1-setup-to-catalog` tool returns, but inline so local models
 * (Gemma 4) can answer in one shot instead of looping tool calls.
 */
function buildF1SetupReferenceBlock(
  carSetupJson: string | undefined,
  telemetry: TelemetryPacket[],
  trackOrdinal: number,
): string {
  const setup = resolveLapF1Setup({ carSetup: carSetupJson, telemetry });
  if (!setup || trackOrdinal < 0) return "";
  const current = normalizePacketSetup(
    setup as unknown as Record<string, unknown>,
  );
  const refs = topCatalogReferences(trackOrdinal, 5, current);
  if (refs.length === 0) return "";

  const lines: string[] = [];
  lines.push(
    `\n\n--- F1 CURRENT SETUP + TOP-5 REFERENCE SETUPS (${getCatalogDisplayName(trackOrdinal) ?? "this track"}) ---`,
  );
  lines.push(
    "Use this data to populate setup[]. Cite rank/team/author per entry. Only propose steps within the step-cap rules.",
  );
  lines.push("");
  lines.push("Current setup:");
  for (const [k, v] of Object.entries(current)) lines.push(`  ${k}: ${v}`);
  for (const r of refs) {
    lines.push("");
    lines.push(
      `Rank ${r.rank} — ${r.team} / ${r.author} — ${r.lapTime} (${r.weather}, ${r.inputDevice}):`,
    );
    const deltas = Object.entries(r.delta ?? {});
    if (deltas.length === 0) {
      lines.push("  (identical to current setup)");
    } else {
      for (const [k, v] of deltas) {
        const sign = (v as number) > 0 ? "+" : "";
        lines.push(
          `  ${k}: ${current[k]} → ${(r.setup as Record<string, number>)[k]} (${sign}${v})`,
        );
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
const lapAnalysisRunKey = (lapId: number) => `lap:${lapId}`;
const inputsAnalysisRunKey = (idA: number, idB: number) =>
  `inputs:${Math.min(idA, idB)}:${Math.max(idA, idB)}`;

const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int()),
});

const IbtImportTokenSchema = z.object({
  token: z.string().uuid(),
});

/** Comma-separated id list in a query string → number[] (ignores junk/empties). */
const IdListSchema = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
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
  .post(
    "/api/laps/bulk-delete",
    zValidator("json", BulkDeleteSchema),
    async (c) => {
      const { ids } = c.req.valid("json");
      let count = 0;
      for (const id of ids) {
        if (await deleteLap(id)) count++;
      }
      return c.json({ deleted: count });
    },
  )

  // ── Export laps as a .zip (must precede :id routes) ─────────
  // Accepts any mix of explicit lap ids and whole sessions:
  //   /api/laps/export-zip?ids=1,2,3&sessionIds=7
  // Re-importable via POST /api/laps/import-zip.
  .get(
    "/api/laps/export-zip",
    zValidator("query", ExportZipQuerySchema),
    async (c) => {
      const { ids, sessionIds } = c.req.valid("query");

      const lapIds = new Set<number>(ids ?? []);
      for (const sessionId of sessionIds ?? []) {
        for (const lap of await getLapsForSession(sessionId))
          lapIds.add(lap.id);
      }
      if (lapIds.size === 0)
        return c.json({ error: "No laps matched the requested ids" }, 404);

      let built: Awaited<ReturnType<typeof buildLapsZip>>;
      try {
        built = await buildLapsZip([...lapIds]);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          409,
        );
      }
      const { bytes, manifest } = built;
      c.header("Content-Type", "application/zip");
      c.header(
        "Content-Disposition",
        `attachment; filename="${lapsZipFilename(manifest)}"`,
      );
      c.header("Content-Length", String(bytes.byteLength));
      return c.body(bytes.slice().buffer as ArrayBuffer);
    },
  )

  // ── Import laps from a .zip produced by export-zip ───────────
  .post("/api/laps/import-zip", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File))
      return c.json({ error: "Missing 'file' in multipart body" }, 400);
    if (!(file.name || "").toLowerCase().endsWith(".zip")) {
      return c.json({ error: "Expected a .zip file" }, 400);
    }

    try {
      const result = await importLapsZip(
        new Uint8Array(await file.arrayBuffer()),
      );
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: `Failed to import zip: ${err instanceof Error ? err.message : String(err)}`,
        },
        400,
      );
    }
  })

  // ── Get single lap ──────────────────────────────────────────
  .get("/api/laps/:id", zValidator("param", IdParamSchema), async (c) => {
    const gameIdResult = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameIdResult.success) {
      return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    }
    const gameId = gameIdResult.data;
    const { id } = c.req.valid("param");
    const lap = await getLapById(id);
    if (!lap || lap.gameId !== gameId) {
      return c.json({ error: "Lap not found" }, 404);
    }

    // Compute sector times server-side
    let sectorTimes: {
      times: number[];
      sectorCount: number;
      boundaryIndices: number[];
      sectorStarts: number[];
      firstDist: number;
      lapDist: number;
    } | null = null;
    const packets = lap.telemetry;
    if (packets.length >= 10 && lap.trackOrdinal != null) {
      const game = getGame(gameId);
      const firstDist = packets[0].DistanceTraveled;
      const lastDist = packets[packets.length - 1].DistanceTraveled;
      const lapDist = lastDist - firstDist;

      if (game.nativeSectors && game.getNativeSectorLayout) {
        const nativeTimeline = computeNativeSectorTimeline(
          packets,
          lap.lapTime,
          game.getNativeSectorLayout,
        );
        if (nativeTimeline && lapDist > 0) {
          sectorTimes = {
            ...nativeTimeline,
            firstDist,
            lapDist,
          };
        }
      } else {
        const sectors = resolveTrack(gameId, lap.trackOrdinal).sectors;
        if (sectors?.s1End && sectors?.s2End && lapDist > 0) {
          // Determine the best time source: CurrentLap if it progresses, else TimestampMS
          const lapProgression =
            packets[packets.length - 1].CurrentLap - packets[0].CurrentLap;
          const useTimestamp = lapProgression < 1; // CurrentLap unreliable (e.g. ACC with invalid iCurrentTime)
          const getTime = (i: number) =>
            useTimestamp
              ? (packets[i].TimestampMS - packets[0].TimestampMS) / 1000
              : packets[i].CurrentLap - packets[0].CurrentLap;

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
            lap.lapTime ||
            (useTimestamp
              ? (packets[packets.length - 1].TimestampMS -
                  packets[0].TimestampMS) /
                1000
              : packets[packets.length - 1].CurrentLap - packets[0].CurrentLap);
          let s3Time = totalLapTime - s1Time - s2Time;
          if (s3Time < 0) s3Time = 0;
          sectorTimes = {
            times: [s1Time, s2Time, s3Time],
            sectorCount: 3,
            boundaryIndices: [s1Idx, s2Idx],
            sectorStarts: [0, sectors.s1End, sectors.s2End],
            firstDist,
            lapDist,
          };
        }
      }
    }

    // Precomputed lap insights — server-side so the client gets them in the
    // initial fetch instead of re-deriving on every render
    const insights = analyzeLap(packets, gameId);

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
  .post(
    "/api/laps/traces",
    zValidator(
      "json",
      z.object({ ids: z.array(z.number().int().positive()).max(200) }),
    ),
    async (c) => {
      const { ids } = c.req.valid("json");
      if (ids.length === 0) return c.json({ traces: [] as EncodedLapTrace[] });

      const laps = await getLapsByIds(ids);
      const traces: EncodedLapTrace[] = [];
      for (const lap of laps) {
        if (lap.telemetry.length === 0) continue;
        const trace = downsampleLap(
          lap.id,
          lap.lapNumber,
          lap.isValid,
          lap.telemetry,
          null,
        );
        if (trace) traces.push(encodeLapTrace(trace));
      }
      return c.json({ traces });
    },
  )

  // ── Export lap telemetry as text ────────────────────────────
  .get(
    "/api/laps/:id/export",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      const packets = lap.telemetry;
      if (packets.length === 0)
        return c.json({ error: "No telemetry data" }, 400);
      const exportText = generateExport(lap, packets);
      return c.text(exportText);
    },
  )

  // ── Export raw session capture (.bin) containing this lap ────
  // The raw capture is stored per-session, so this hands back the whole
  // session .bin (meta frame + every frame). Re-importable via POST
  // /api/laps/import, which re-runs the pipeline to rebuild all laps.
  .get(
    "/api/laps/:id/export-bin",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const [row] = await getLapsRaw([id]);
      if (!row) return c.json({ error: "Lap not found" }, 404);
      if (!row.rawFile)
        return c.json({ error: "No raw capture available for this lap" }, 409);

      const file = Bun.file(row.rawFile);
      if (!(await file.exists()))
        return c.json({ error: "Raw capture file is missing on disk" }, 410);
      let bytes = new Uint8Array(await file.arrayBuffer());
      if (!row.rawFile.endsWith(".gz")) {
        bytes = new Uint8Array(await gzipAsync(Buffer.from(bytes)));
      }

      const trackName = tryGetGame(row.gameId)?.getTrackName?.(
        row.trackOrdinal ?? -1,
      );
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
    },
  )

  // ── Import a raw session capture (.bin) ─────────────────────
  // Feeds an uploaded session .bin through the full pipeline so its laps land
  // in the DB as a fresh session. GameId is detected from the frame content
  // (each adapter's canHandle()), not the uploaded filename.
  .post("/api/laps/import", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File))
      return c.json({ error: "Missing 'file' in multipart body" }, 400);

    const uploadName = file.name || "upload.bin";
    const lower = uploadName.toLowerCase();
    if (!lower.endsWith(".bin") && !lower.endsWith(".bin.gz")) {
      return c.json({ error: "Expected a .bin or .bin.gz file" }, 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const gameId = detectGameIdFromBuffer(bytes);
    if (!gameId) {
      return c.json(
        {
          error: `Could not detect game from "${uploadName}" — no recognized frame format found. Supported games: ${KNOWN_GAME_IDS.join(", ")}.`,
        },
        400,
      );
    }

    try {
      const { packetCount, laps } = await importSessionBin(bytes, gameId);
      if (packetCount === 0)
        return c.json({ error: "No telemetry packets found in file" }, 400);
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
      return c.json(
        {
          error: "Failed to import file",
          details: String(err?.message ?? err),
        },
        500,
      );
    }
  })

  // ── Games a MoTeC log can be imported for ───────────────────
  .get("/api/motec/targets", (c) => {
    initMotecTargets();
    return c.json(
      getMotecTargets().map((t) => ({
        gameId: t.gameId,
        displayName: t.displayName,
        routePrefix: t.routePrefix,
        carsEndpoint: t.carsEndpoint,
        limitations: t.limitations,
      })),
    );
  })

  // ── Import a MoTeC i2 log (.ld, optionally with its .ldx) ───
  .post("/api/laps/import-motec", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File))
      return c.json({ error: "Missing 'file' in multipart body" }, 400);
    if (!file.name.toLowerCase().endsWith(".ld"))
      return c.json({ error: "Expected a MoTeC .ld file" }, 400);

    const sidecar = form?.get("ldx");
    const ldxText = sidecar instanceof File ? await sidecar.text() : undefined;
    const num = (key: string): number | undefined => {
      const raw = form?.get(key);
      if (typeof raw !== "string" || raw.trim() === "") return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const carOrdinal = num("carOrdinal");
    const trackOrdinal = num("trackOrdinal");
    if (carOrdinal === undefined || trackOrdinal === undefined) {
      return c.json({ error: "carOrdinal and trackOrdinal are required" }, 400);
    }

    const gameIdRaw = form?.get("gameId");
    let target;
    try {
      target = resolveMotecTarget(
        typeof gameIdRaw === "string" && gameIdRaw ? gameIdRaw : undefined,
      );
    } catch (err: unknown) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }

    const tuneId = num("tuneId");
    if (tuneId !== undefined && !(await getDbTune(tuneId))) {
      return c.json({ error: `No setup with id ${tuneId}` }, 400);
    }

    try {
      const result = await importMotec(
        Buffer.from(await file.arrayBuffer()),
        ldxText,
        {
          gameId: target.gameId,
          carOrdinal,
          trackOrdinal,
          tuneId,
        },
      );
      if (result.laps.length === 0) {
        return c.json(
          {
            error: "No laps could be detected in this log",
            meta: result.meta,
            limitations: result.limitations,
          },
          400,
        );
      }
      return c.json({
        ...result,
        ok: true,
        gameId: target.gameId,
        routePrefix: target.routePrefix,
        imported: result.laps.length,
      });
    } catch (err: unknown) {
      console.error(
        "[MoTeC Import] Failed:",
        err instanceof Error ? err.message : String(err),
      );
      return c.json(
        {
          error: "Failed to import MoTeC log",
          details: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  })

  // ── Import an iRacing disk telemetry capture (.ibt) ─────────
  .post("/api/laps/import-ibt/preview", async (c) => {
    const uploadName = c.req.header("x-file-name") ?? "session.ibt";
    if (!uploadName.toLowerCase().endsWith(".ibt"))
      return c.json({ error: "Expected an .ibt file" }, 400);
    const declaredHeader =
      c.req.header("x-file-size") ?? c.req.header("content-length");
    const declaredBytes = declaredHeader ? Number(declaredHeader) : undefined;
    try {
      return c.json(
        await stageIbtUpload(c.req.raw.body, uploadName, declaredBytes),
      );
    } catch (error) {
      const status = error instanceof IbtImportError ? error.status : 400;
      const message = error instanceof Error ? error.message : String(error);
      console.error("[IBT Import] Preview failed:", message);
      return c.json({ error: `Failed to preview IBT: ${message}` }, status);
    }
  })
  .post(
    "/api/laps/import-ibt/commit",
    zValidator("json", IbtImportTokenSchema),
    async (c) => {
      const { token } = c.req.valid("json");
      try {
        const { packetCount, laps, preview } = await commitStagedIbt(token);
        return c.json({
          ok: true,
          gameId: "iracing" as const,
          routePrefix: getGame("iracing").routePrefix,
          packetCount,
          imported: laps.length,
          laps,
          preview,
        });
      } catch (error) {
        const status = error instanceof IbtImportError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        console.error("[IBT Import] Commit failed:", message);
        return c.json({ error: `Failed to import IBT: ${message}` }, status);
      }
    },
  )
  .post(
    "/api/laps/import-ibt/cancel",
    zValidator("json", IbtImportTokenSchema),
    (c) => {
      cancelStagedIbt(c.req.valid("json").token);
      return c.json({ ok: true });
    },
  )

  // ── AI analysis ─────────────────────────────────────────────
  .get(
    "/api/laps/:id/analyse/status",
    zValidator("param", IdParamSchema),
    (c) => c.json(getAnalysisRun(`lap:${c.req.valid("param").id}`) ?? { status: "none" }),
  )

  .post(
    "/api/laps/:id/analyse",
    zValidator("param", IdParamSchema),
    zValidator("query", AnalyseQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { regenerate, cacheOnly } = c.req.valid("query");

      // Validate lap existence/telemetry before opening a stream. This keeps
      // legacy HTTP error statuses for explicit regeneration as well as cache
      // reuse; only actual generation is deferred into NDJSON.
      const preflightResult = await generateLapAnalysis(id, {
        cacheOnly: true,
        preflight: !cacheOnly || regenerate,
      });
      if (preflightResult.error) {
        const status =
          preflightResult.error === "Lap not found"
            ? 404
            : preflightResult.error === "No telemetry data"
              ? 400
              : 400;
        return c.json({ error: preflightResult.error }, status);
      }
      if (!regenerate && preflightResult.cached) {
        return c.json(preflightResult);
      }
      if (cacheOnly && !regenerate) {
        return c.json(preflightResult);
      }
      if (!beginAnalysisRun(`lap:${id}`)) {
        return c.json({ error: "Analysis already in progress" }, 409);
      }


      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          const writeEvent = (event: unknown) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch {
              // Client disconnected.
            }
          };
          const keepAlive = setInterval(
            () => writeEvent({ type: "ping" }),
            200_000,
          );
          try {
            const result = await generateLapAnalysis(id, { regenerate });
            if (result.error)
              writeEvent({ type: "error", message: result.error });
            else writeEvent({ type: "result", ...result });
          } catch (err) {
            const aiError = toClientAiError(err);
            console.error("[AI] Analysis failed:", aiError.message);
            writeEvent({ type: "error", ...aiError });
          } finally {
            finishAnalysisRun(`lap:${id}`);
            clearInterval(keepAlive);
            try {
              controller.close();
            } catch {
              // Stream already closed.
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
    },
  )

  .delete(
    "/api/laps/:id/analyse",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        await deleteAnalysisQuery(id);
      } catch (err: any) {
        console.error("[Analysis] Failed to clear:", err.message);
      }
      return c.json({ ok: true });
    },
  )

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
      const raw = (await memory.recall({ threadId })).messages ?? [];
      const systemPrompt = await getChatSystemPrompt(threadId, memory as unknown as Parameters<typeof getChatSystemPrompt>[1]);
      if (c.req.query("export") === "1") return c.json(buildChatExport(systemPrompt, raw));
      return c.json({ messages: sanitizeChatHistoryMessages(chatMemoryMessagesToUiMessages(raw)) });
    } catch (err: any) {
      console.error("[Chat] Failed to load messages:", err.message);
      return c.json({ messages: [] });
    }
  })

  // ── Chat: send message (streaming) ─────────────────────────
  .post(
    "/api/laps/:id/chat",
    zValidator("param", IdParamSchema),
    zValidator("json", ChatBodySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { messages } = c.req.valid("json");

      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      if (lap.telemetry.length === 0)
        return c.json({ error: "No telemetry data" }, 400);

      const settings = loadSettings();
      const trackOrdinal = lap.trackOrdinal ?? 0;
      // Curated corners from `track_corners` first; fall back to telemetry
      // detection (T1..Tn) when the track has no entries — lets the client
      // resolve "T13" card clicks to the correct position instead of lap start.
      let corners =
        trackOrdinal > 0 && lap.gameId
          ? await getCorners(trackOrdinal, lap.gameId)
          : [];
      if (corners.length === 0 && lap.telemetry.length > 0) {
        corners = detectCorners(lap.telemetry);
      }


      // Cached analysis is retrieved explicitly by the agent via get_lap_analysis.
      const systemPrompt = buildChatSystemPrompt(
        lap,
        lap.telemetry,
        corners,
        settings.unit,
        settings.temperatureUnit,
        settings.language,
      );

      // Provider/key/model plumbing — inlined from the old startChatStream
      // helper (removed, was the NDJSON transport's shared provider setup)
      // since this route now speaks the AI SDK v5 UI-message-stream
      // protocol instead).
      const chatProvider = settings.chatProvider;
      if (!chatProvider) {
        return c.json(
          {
            error: "No AI provider selected. Choose one in Settings → AI Chat.",
          },
          400,
        );
      }
      if (chatProvider === "gemini") {
        const key = await getSecret("gemini-api-key");
        if (!key)
          return c.json(
            { error: "Gemini API key not set. Add it in Settings → AI Chat." },
            400,
          );
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
        delete process.env.OPENAI_BASE_URL;
      } else if (chatProvider === "openai") {
        const key = await getSecret("openai-api-key");
        if (!key)
          return c.json(
            { error: "OpenAI API key not set. Add it in Settings → AI Chat." },
            400,
          );
        process.env.OPENAI_API_KEY = key;
        delete process.env.OPENAI_BASE_URL;
      } else if (chatProvider === "local") {
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
        process.env.OPENAI_BASE_URL =
          settings.localEndpoint || "http://localhost:1234/v1";
      }

      const chatModelLabel =
        settings.chatModel ||
        (chatProvider === "openai"
          ? "gpt-4o-mini"
          : chatProvider === "local"
            ? "local-model"
            : "gemini-flash-latest");

      const threadId = await resolveActiveThread(chatThreadId(id));
      await ensureSystemPrompt(threadId, systemPrompt);
      const turnStartedAt = Date.now();
      try {
        const requestContext = new RequestContext();
        requestContext.set(CHAT_TURN_CONTEXT_KEY, systemPrompt);
        const { run, isNew } = reserveChatRun(threadId);
        if (isNew) {
          let stream;
          try {
            stream = await lapChatAgent.stream(messages, {
              requestContext,
              memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
              abortSignal: run.abortController.signal,
              prepareStep: ({ stepNumber }) => stepNumber === 0
                ? {
                    toolChoice: lapChatToolChoice(stepNumber),
                    activeTools: ["get_lap_analysis"],
                  }
                : { toolChoice: lapChatToolChoice(stepNumber) },
              maxSteps: 5,
              providerOptions: {
                openai: { reasoningEffort: "medium" },
                google: buildGoogleReasoningProviderOptions(
                  chatModelLabel,
                  settings.chatThinkingBudget,
                ) as never,
              },
            });
          } catch (err) {
            finishRun(run);
            throw err;
          }
          startDetachedAgentTurn(run, {
            agentStream: stream,
            originalMessages: messages,
            memory: getChatMemory(),
            threadId,
            turnStartedAt,
            abortSignal: run.abortController.signal,
          });
        }
        const response = createUIMessageStreamResponse({ stream: buildReplayStream(run) });
        response.headers.set("x-resumable-stream-id", run.runId);
        return response;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Chat] Stream failed:", message);
        return c.json({ error: message }, 500);
      }
    },
  )

  // ── Chat: clear messages ───────────────────────────────────
  .delete(
    "/api/laps/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        await deleteChatLineage(chatThreadId(id));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Chat] Failed to clear thread:", message);
        return c.json({ error: message }, 500);
      }
      try {
        await deleteAnalysisQuery(id);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Chat] Failed to clear analysis:", message);
      }
      return c.json({ ok: true });
    },
  )

  // ── Update lap notes ───────────────────────────────────────
  .patch(
    "/api/laps/:id/notes",
    zValidator("param", IdParamSchema),
    zValidator("json", z.object({ notes: z.string().nullable() })),
    async (c) => {
      const { id } = c.req.valid("param");
      await updateLapNotes(id, c.req.valid("json").notes);
      return c.json({ ok: true });
    },
  )

  // ── Manual lap exclusion from tuning aggregate (setup-engineer-flow §Phase 7) ──
  .post(
    "/api/laps/:id/experiment-excluded",
    zValidator("param", IdParamSchema),
    zValidator("json", z.object({ excluded: z.boolean() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { excluded } = c.req.valid("json");
      const { ok, prev, experimentId } = await setLapExperimentExcluded(
        id,
        excluded,
      );
      if (!ok) return c.json({ error: "Lap not found" }, 404);

      // Best-effort: an action-log write failure must not fail the request —
      // the lap flag is already committed. Only log when the lap is linked
      // to a tuning session (laps outside a tuning session have nothing to undo into).
      if (experimentId != null) {
        try {
          await recordAction(experimentId, "set-lap-excluded", {
            lapId: id,
            prevExcluded: prev,
          });
        } catch (err: any) {
          console.error(
            "[LapRoutes] Failed to log set-lap-excluded action:",
            err?.message,
          );
        }
      }

      return c.json({ ok: true, lapId: id, excluded });
    },
  )

  // ── Recheck lap validity (dev tool) ─────────────────────────
  .post(
    "/api/laps/:id/recheck",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);

      const quality = assessLapRecording(lap.telemetry, lap.lapTime);

      // Recompute sector times
      const packets = lap.telemetry;
      let sectors: number[] | null = null;
      if (packets.length >= 50 && lap.gameId && lap.trackOrdinal != null) {
        sectors = await computeLapSectors(
          lap.trackOrdinal,
          lap.gameId as GameId,
          packets,
          lap.lapTime,
        );
      }

      await updateLapValidity(
        id,
        quality.valid,
        quality.valid ? null : quality.reason,
        sectors,
      );
      return c.json({
        id,
        valid: quality.valid,
        reason: quality.reason,
        sectors,
      });
    },
  )

  // ── Delete single lap ───────────────────────────────────────
  .delete("/api/laps/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const deleted = await deleteLap(id);
    if (!deleted) return c.json({ error: "Lap not found" }, 404);
    return c.json({ success: true });
  })

  // ── Compare two laps ───────────────────────────────────────
  .get(
    "/api/laps/:id1/compare/:id2",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      if (id1 === id2)
        return c.json({ error: "Cannot compare a lap with itself" }, 400);

      const lapA = await getLapById(id1);
      if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);

      const lapB = await getLapById(id2);
      if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);

      if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0)
        return c.json(
          { error: "One or both laps have no telemetry data" },
          400,
        );

      const trackOrdinal = lapA.trackOrdinal ?? 0;
      let corners: Awaited<ReturnType<typeof getCorners>> = [];
      try {
        corners = lapA.gameId
          ? await getCorners(trackOrdinal, lapA.gameId)
          : [];
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
    },
  )

  // ── Inputs comparison analysis ─────────────────────────────
  .get(
    "/api/laps/:id1/compare/:id2/inputs-analyse/status",
    zValidator("param", CompareParamsSchema),
    (c) => {
      const { id1, id2 } = c.req.valid("param");
      return c.json(
        getAnalysisRun(inputsAnalysisRunKey(id1, id2)) ?? { status: "none" },
      );
    },
  )
  .post(
    "/api/laps/:id1/compare/:id2/inputs-analyse",
    zValidator("param", CompareParamsSchema),
    zValidator("query", AnalyseQuerySchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      const { regenerate, cacheOnly } = c.req.valid("query");
      if (id1 === id2)
        return c.json({ error: "Cannot compare a lap with itself" }, 400);

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
      if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0)
        return c.json(
          { error: "One or both laps have no telemetry data" },
          400,
        );

      const trackOrdinal = lapA.trackOrdinal ?? 0;
      let corners: Awaited<ReturnType<typeof getCorners>> = [];
      try {
        corners = lapA.gameId
          ? await getCorners(trackOrdinal, lapA.gameId)
          : [];
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
          type:
            s.type === "corner" ? ("corner" as const) : ("straight" as const),
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
        buildCompareInsightsBlock(
          "Lap A",
          lapA.telemetry,
          lapA.gameId as GameId | undefined,
        ) +
          buildCompareInsightsBlock(
            "Lap B",
            lapB.telemetry,
            lapB.gameId as GameId | undefined,
          ),
      );

      // Set provider env vars before calling Mastra (the dynamic model resolver
      // reads settings at request time but env-based API keys must be in scope).
      if (!settings.aiProvider) {
        return c.json(
          {
            error:
              "No AI provider selected. Choose one in Settings → AI Analysis.",
          },
          400,
        );
      }
      if (settings.aiProvider === "openai") {
        const key = await getSecret("openai-api-key");
        if (!key)
          return c.json(
            {
              error:
                "OpenAI API key not set. Add it in Settings → AI Analysis.",
            },
            400,
          );
        process.env.OPENAI_API_KEY = key;
      } else if (settings.aiProvider === "local") {
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
        process.env.OPENAI_BASE_URL =
          settings.localEndpoint || "http://localhost:1234/v1";
      } else {
        const key = await getSecret("gemini-api-key");
        if (!key)
          return c.json(
            {
              error:
                "Gemini API key not set. Add it in Settings → AI Analysis.",
            },
            400,
          );
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      }
      const inputsRunKey = inputsAnalysisRunKey(id1, id2);
      if (!beginAnalysisRun(inputsRunKey)) {
        return c.json({ error: "Inputs comparison already in progress" }, 409);
      }


      try {
        const start = performance.now();
        const result = await compareEngineerAgent.generate(prompt, {
          maxSteps: 5,
          structuredOutput: {
            schema: InputsCompareSchema,
            // LM Studio only accepts `response_format: json_schema` (it rejects
            // `json_object`), and for reasoning models such as qwen3.5 it emits the
            // schema-constrained JSON into `reasoning_content` while leaving
            // `content` empty — so no object is ever parsed and this route throws.
            // Prompt injection keeps the answer on the plain-text channel, which
            // those models fill normally. Hosted providers parse native structured
            // output fine, so only the local path opts in.
            ...(settings.aiProvider === "local"
              ? { jsonPromptInjection: true }
              : {}),
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
        const totalUsage =
          (result as any).totalUsage ?? (result as any).usage ?? {};
        const usage = {
          inputTokens: totalUsage.inputTokens ?? totalUsage.promptTokens ?? 0,
          outputTokens:
            totalUsage.outputTokens ?? totalUsage.completionTokens ?? 0,
          costUsd: 0,
          durationMs,
          model: settings.aiModel || settings.aiProvider,
        };
        await saveCompareAnalysis(id1, id2, analysisJson, usage, "inputs");
        return c.json({ analysis: analysisJson, cached: false, usage });
      } catch (err: any) {
        const aiError = toClientAiError(err);
        const errorMessage = formatClientAiErrorMessage(aiError);
        console.error("[InputsCompare] Failed:", errorMessage);
        return c.json(
          {
            error: errorMessage,
            statusCode: aiError.statusCode,
            retryable: aiError.retryable,
            provider: aiError.provider,
            modelId: aiError.modelId,
            upstream: aiError.upstream,
          },
          errorMessage.includes("timed out") ? 504 : 500,
        );
      } finally {
        finishAnalysisRun(inputsRunKey);
      }
    },
  )

  // ── Inputs comparison: clear cached analysis ───────────────
  .delete(
    "/api/laps/:id1/compare/:id2/inputs-analyse",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      try {
        await deleteCompareAnalysis(id1, id2, "inputs");
      } catch (err: any) {
        console.error("[InputsCompare] Failed to clear:", err.message);
      }
      return c.json({ ok: true });
    },
  )

  // ── Compare chat: get messages ─────────────────────────────
  .get(
    "/api/laps/:id1/compare/:id2/chat",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const base = compareChatThreadId(id1, id2);
        const genParam = Number(c.req.query("gen"));
        const threadId =
          Number.isInteger(genParam) && genParam >= 1
            ? generationThreadId(base, genParam)
            : await resolveActiveThread(base);
        const thread = await memory.getThreadById({ threadId });
        if (!thread) return c.json({ messages: [] });
        const raw = (await memory.recall({ threadId })).messages ?? [];
        const systemPrompt = await getChatSystemPrompt(threadId, memory as unknown as Parameters<typeof getChatSystemPrompt>[1]);
        if (c.req.query("export") === "1") return c.json(buildChatExport(systemPrompt, raw));
        return c.json({ messages: sanitizeChatHistoryMessages(chatMemoryMessagesToUiMessages(raw)) });
      } catch (err: any) {
        console.error("[CompareChat] Failed to load messages:", err.message);
        return c.json({ messages: [] });
      }
    },
  )

  // ── Compare chat: send message (streaming) ────────────────
  .post(
    "/api/laps/:id1/compare/:id2/chat",
    zValidator("param", CompareParamsSchema),
    zValidator("json", ChatBodySchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      const { messages } = c.req.valid("json");
      if (id1 === id2)
        return c.json({ error: "Cannot compare a lap with itself" }, 400);

      const lapA = await getLapById(id1);
      if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);
      const lapB = await getLapById(id2);
      if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);
      if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0)
        return c.json(
          { error: "One or both laps have no telemetry data" },
          400,
        );
      const [analysisA, analysisB, inputsAnalysis] = await Promise.all([
        getAnalysis(id1),
        getAnalysis(id2),
        getCompareAnalysis(id1, id2, "inputs"),
      ]);
      if (!analysisA || !analysisB || !inputsAnalysis) {
        return c.json(
          {
            error:
              "Run analysis for both laps and compare inputs before starting chat.",
          },
          400,
        );
      }

      const trackOrdinal = lapA.trackOrdinal ?? 0;
      let corners: Corner[] = [];
      try {
        corners = lapA.gameId
          ? await getCorners(trackOrdinal, lapA.gameId)
          : [];
      } catch {
        /* corners optional */
      }

      const comparison = compareLaps(lapA.telemetry, lapB.telemetry, corners);

      const segments: PromptSegment[] | null =
        resolveTrack(lapA.gameId, lapA.trackOrdinal).segments.map((s) => ({
          name: s.name,
          type: s.type === "corner" ? "corner" : "straight",
          startFrac: s.startFrac,
          endFrac: s.endFrac,
          number: s.number,
          covers: s.covers,
        }));
      const settings = loadSettings();
      const systemPrompt = buildCompareChatContext(
        {
          id: id1,
          lapNumber: lapA.lapNumber,
          lapTime: lapA.lapTime,
          isValid: lapA.isValid,
          carOrdinal: lapA.carOrdinal,
          trackOrdinal: lapA.trackOrdinal,
          gameId: lapA.gameId as GameId,
        },
        {
          id: id2,
          lapNumber: lapB.lapNumber,
          lapTime: lapB.lapTime,
          isValid: lapB.isValid,
          carOrdinal: lapB.carOrdinal,
          trackOrdinal: lapB.trackOrdinal,
          gameId: lapB.gameId as GameId,
        },
        comparison,
        segments,
      );

      const chatProvider = settings.chatProvider;

      if (!chatProvider) {
        return c.json(
          {
            error: "No AI provider selected. Choose one in Settings → AI Chat.",
          },
          400,
        );
      }
      if (chatProvider === "gemini") {
        const key = await getSecret("gemini-api-key");
        if (!key)
          return c.json(
            { error: "Gemini API key not set. Add it in Settings → AI Chat." },
            400,
          );
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
        delete process.env.OPENAI_BASE_URL;
      } else if (chatProvider === "openai") {
        const key = await getSecret("openai-api-key");
        if (!key)
          return c.json(
            { error: "OpenAI API key not set. Add it in Settings → AI Chat." },
            400,
          );
        process.env.OPENAI_API_KEY = key;
        delete process.env.OPENAI_BASE_URL;
      } else if (chatProvider === "local") {
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
        process.env.OPENAI_BASE_URL =
          settings.localEndpoint || "http://localhost:1234/v1";
      }

      const chatModelLabel =
        settings.chatModel ||
        (chatProvider === "openai"
          ? "gpt-4o-mini"
          : chatProvider === "local"
            ? "local-model"
            : "gemini-flash-latest");

      const threadId = await resolveActiveThread(compareChatThreadId(id1, id2));
      await ensureSystemPrompt(threadId, systemPrompt);
      const turnStartedAt = Date.now();
      try {
        const requestContext = new RequestContext();
        requestContext.set(CHAT_TURN_CONTEXT_KEY, systemPrompt);
        const { run, isNew } = reserveChatRun(threadId);
        if (isNew) {
          let stream;
          try {
            stream = await compareChatAgent.stream(messages, {
              ...chatMemoryOptions(threadId),
              requestContext,
              abortSignal: run.abortController.signal,
              toolChoice: compareChatToolChoice(messages),
              maxSteps: 6,
              providerOptions: {
                openai: { reasoningEffort: "medium" },
                google: buildGoogleReasoningProviderOptions(
                  chatModelLabel,
                  settings.chatThinkingBudget,
                ) as never,
              },
            });
          } catch (err) {
            finishRun(run);
            throw err;
          }
          startDetachedAgentTurn(run, {
            agentStream: stream,
            originalMessages: messages,
            memory: getChatMemory(),
            threadId,
            turnStartedAt,
            abortSignal: run.abortController.signal,
          });
        }
        const response = createUIMessageStreamResponse({ stream: buildReplayStream(run) });
        response.headers.set("x-resumable-stream-id", run.runId);
        return response;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[CompareChat] Stream failed:", message);
        return c.json({ error: message }, 500);
      }
    },
  )

  // ── Compare chat: clear messages ───────────────────────────
  .delete(
    "/api/laps/:id1/compare/:id2/chat",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      try {
        await deleteChatLineage(compareChatThreadId(id1, id2));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[CompareChat] Failed to clear thread:", message);
        return c.json({ error: message }, 500);
      }
      return c.json({ ok: true });
    },
  )

  // ── Delete ALL laps ─────────────────────────────────────────
  .delete("/api/laps", async (c) => {
    const laps = await getLaps();
    let count = 0;
    for (const lap of laps) {
      if (await deleteLap(lap.id)) count++;
    }
    return c.json({ deleted: count });
  });
