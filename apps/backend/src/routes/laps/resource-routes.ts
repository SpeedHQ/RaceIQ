import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { replayRoutes } from "@raceiq/lap-replay/server";

import { IdParamSchema } from "@raceiq/shared/platform/http/route-schemas";
import { GameIdSchema, type GameId } from "@raceiq/shared/games/ids";
import { getGame, tryGetGame } from "@raceiq/shared/games/registry";
import { encodeLmuPacket } from "@raceiq/shared/telemetry/lmu-context";
import { backfillLapInsights, getOrComputeLapInsights } from "@raceiq/backend-core/lap-analysis/metrics-store";
import { alignLapSet, prepareLapSetAlignmentIndex, type AlignmentLapInput } from "@raceiq/analysis-core/racing/laps/alignment/build";
import { encodeAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/codec";
import type { EncodedAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/types";
import { getLaps, getLapById, getLapsByIds, getLapsRaw, getSessionLaps } from "@raceiq/backend-core/db/lap-read-queries";
import { alignedTelemetryCacheGet, alignedTelemetryCacheSet, lapSetAlignmentIndexCacheGet, lapSetAlignmentIndexCacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { loadSessionCapture, loadSessionSource, resolveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { getLiveLapCaptureSnapshot } from "@raceiq/backend-core/db/live-capture-queries";
import { resolveLiveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { deleteLap, updateLapNotes, updateLapValidity } from "@raceiq/backend-core/db/lap-mutation-queries";
import { setLapFavorite } from "@raceiq/backend-core/db/session-queries";
import { setLapExperimentExcluded } from "@raceiq/backend-core/db/experiment-lap-queries";
import { recordAction } from "@raceiq/backend-core/db/experiment-action-queries";
import { assessLapRecording } from "@raceiq/telemetry-core/processor/lap-policy";
import { computeNativeSectorTimeline, computeLapSectors } from "@raceiq/telemetry-core/processor/sectors";
import { generateExport } from "@raceiq/backend-core/lap-analysis/report";
import { resolveTrack } from "@raceiq/backend-core/tracks/info";
import { computeLineSpreadTrace } from "@raceiq/backend-core/lap-analysis/consistency";
import { hasWorldPositions } from "@raceiq/shared/racing/tracks/path";
import { BulkDeleteSchema, LapsQuerySchema, CompareLineSpreadQuerySchema, AlignedTelemetryRequestSchema, LapInsightBackfillSchema } from "./support";
import { resolveLapCorners } from "../../tracks/corner-resolution";
import { createSessionAnalyseRoutes } from "@raceiq/session-analyse/server";
import { resolveLapF1Setup } from "@raceiq/backend-core/ai/f1-setup-identity";

const gzipAsync = promisify(gzip);

export const resourceRoutes = new Hono()
  .route("/", replayRoutes)
  .route("/", createSessionAnalyseRoutes(resolveLapCorners))
  .get("/api/laps", zValidator("query", LapsQuerySchema), async (c) => {
    const { gameId, sessionId } = c.req.valid("query");
    const lapList = sessionId != null ? await getSessionLaps(gameId!, sessionId) : await getLaps(gameId);
    return c.json(lapList);
  })
  .get("/api/laps/compare-line-spread", zValidator("query", CompareLineSpreadQuerySchema), async (c) => {
    const { gameId, lapIds } = c.req.valid("query");
    const loaded = await getLapsByIds(lapIds);
    if (loaded.length !== lapIds.length) return c.json({ error: "Selected laps not found." }, 400);
    const ordered = lapIds.map((id) => loaded.find((lap) => lap.id === id)!);
    const [first, second] = ordered;
    if (first!.gameId !== gameId || second!.gameId !== gameId || first!.trackId !== second!.trackId) {
      return c.json({ error: "Selected laps must share game and track." }, 400);
    }
    if (ordered.some((lap) => lap.parseError || lap.telemetry.length < 30 || !hasWorldPositions(lap.telemetry))) return c.json(null);
    const corners = await resolveLapCorners(first!.trackId, gameId, first!.telemetry);
    const trace = computeLineSpreadTrace(ordered.map((lap) => lap.telemetry), lapIds, corners);
    if (!trace || !Number.isFinite(trace.consistencyScore) || !Number.isFinite(trace.overallSpreadM)) return c.json(null);
    const { lapLines: _lapLines, ...compactTrace } = trace;
    return c.json(compactTrace);
  })



  .post("/api/lap-insights/backfill", zValidator("json", LapInsightBackfillSchema), async (c) =>
    c.json(await backfillLapInsights(c.req.valid("json"))),
  )

  .post("/api/laps/bulk-delete", zValidator("json", BulkDeleteSchema), async (c) => {
    const { ids } = c.req.valid("json");
    let count = 0;
    for (const id of ids) {
      if (await deleteLap(id)) count++;
    }
    return c.json({ deleted: count });
  })

  .post("/api/laps/aligned-telemetry", zValidator("json", AlignedTelemetryRequestSchema), async (c) => {
    const request = c.req.valid("json");
    if (request.step === 1) {
      const cached = alignedTelemetryCacheGet(request.ids);
      if (cached !== undefined) return c.body(cached, 200, { "Content-Type": "application/json; charset=UTF-8", "X-RaceIQ-Cache": "HIT" });
    }
    const laps = await getLapsByIds(request.ids);
    const byId = new Map(laps.map((lap) => [lap.id, lap]));
    for (const id of request.ids) if (!byId.has(id)) return c.json({ error: `Lap ${id} not found` }, 404);
    for (const id of request.ids) if (byId.get(id)!.telemetry.length === 0) return c.json({ error: `Lap ${id} has no telemetry data` }, 400);
    const first = byId.get(request.ids[0]!)!;
    if (laps.some((lap) => lap.gameId !== first.gameId || lap.trackId !== first.trackId)) return c.json({ error: "Laps must belong to the same game and track" }, 400);
    const inputs: AlignmentLapInput[] = request.ids.map((id) => {
      const lap = byId.get(id)!;
      return {
        lapId: lap.id, lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, telemetry: lap.telemetry,
        sectorTimes: lap.sectorTimes ?? null,
        sectorStarts: getGame(lap.gameId as GameId).getNativeSectorLayout?.(lap.telemetry[0]!)?.starts ?? null,
      };
    });
    const cachedIndex = lapSetAlignmentIndexCacheGet(request.ids);
    const alignmentIndex = cachedIndex ?? prepareLapSetAlignmentIndex(inputs, { gridStepMeters: request.step });
    const range = request.step === 0.1 ? { start: request.start, end: request.end } : undefined;
    const set = alignLapSet(inputs, { gridStepMeters: request.step, distanceRangeMeters: range, preparedIndex: alignmentIndex });
    if (!cachedIndex) lapSetAlignmentIndexCacheSet(request.ids, alignmentIndex);
    if (request.step === 0.1 && set.distanceEndMeters <= set.distanceStartMeters) return c.json({ error: "Detail range is outside aligned lap span" }, 400);
    const body = JSON.stringify(encodeAlignedLapSet(set) as EncodedAlignedLapSet);
    if (request.step === 1) alignedTelemetryCacheSet(request.ids, body);
    return c.body(body, 200, { "Content-Type": "application/json; charset=UTF-8", "X-RaceIQ-Cache": "MISS" });
  })
  .get("/api/laps/:id/setup", zValidator("param", IdParamSchema), async (c) => {
    const gameIdResult = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameIdResult.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const lap = await getLapById(Number(c.req.valid("param").id));
    if (!lap || lap.gameId !== gameIdResult.data) return c.json({ error: "Lap not found" }, 404);
    return c.json({ setup: gameIdResult.data === "f1-2025" ? resolveLapF1Setup({ carSetup: lap.carSetup, telemetry: lap.telemetry }) : null });
  })


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
    if (packets.length >= 10 && lap.trackId) {
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
        const sectors = resolveTrack(gameId, lap.trackId).sectors;
        if (sectors?.s1End && sectors?.s2End && lapDist > 0) {
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
    const insights = await getOrComputeLapInsights(id) ?? [];

    return c.json({ ...lap, telemetry: gameId === "lmu" ? lap.telemetry.map(encodeLmuPacket) : lap.telemetry, sectorTimes, insights });
  })

  .get("/api/laps/:id/export", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);
    const packets = lap.telemetry;
    if (packets.length === 0) return c.json({ error: "No telemetry data" }, 400);
    const exportText = generateExport(lap, packets);
    return c.text(exportText);
  })

  .get("/api/laps/:id/export-bin", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await getLapsRaw([id]);
    if (!row) return c.json({ error: "Lap not found" }, 404);
    if (row.captureLayoutVersion != null && row.captureLayoutVersion !== 1 && row.captureLayoutVersion !== 2 && row.captureLayoutVersion !== 3) {
      return c.json({ error: `Unsupported capture layout version ${row.captureLayoutVersion}` }, 422);
    }
    const published = row.captureLayoutVersion != null;
    const bundled = published && (row.captureLayoutVersion === 1 || row.captureLayoutVersion === 2 || row.captureLayoutVersion === 3);
    if (published && row.captureLayoutVersion !== 3 && (!row.captureManifestFile || !row.captureChunkId || (row.captureLayoutVersion === 2 && !row.captureArchiveFile))) {
      return c.json({ error: "Published capture layout has incomplete capture references" }, 422);
    }
    if (!published && !row.rawFile) return c.json({ error: "No raw capture available for this lap" }, 409);
    if (row.captureLayoutVersion === 3) {
      const live = await getLiveLapCaptureSnapshot(row.sessionId, row.id);
      if (!live) return c.json({ error: "Live lap capture member is not committed" }, 409);
    }

    let bytes: Uint8Array;
    try {
      if (row.captureLayoutVersion === 3) {
        const live = await getLiveLapCaptureSnapshot(row.sessionId, row.id);
        if (!live) return c.json({ error: "Live lap capture member is not committed" }, 409);
        const artifact = resolveLiveLapCaptureArtifact(live.archivePath, live.snapshot);
        bytes = await loadSessionCapture({
          rawFile: artifact.path, artifact: artifact.artifact, source: null, gameId: row.gameId as GameId,
          carId: row.carId, trackId: row.trackId,
        });
      } else if (bundled) {
        const artifact = await resolveLapCaptureArtifact(row.captureManifestFile!, row.captureChunkId!, row.id, row);
        bytes = await loadSessionCapture({
          rawFile: artifact.path, artifact: artifact.artifact, source: null, gameId: row.gameId as GameId,
          carId: row.carId, trackId: row.trackId,
        });
      } else {
        const loaded = await loadSessionSource({
          rawFile: row.rawFile!, source: row.source ?? null, gameId: row.gameId as GameId,
          carId: row.carId, trackId: row.trackId, captureFormatVersion: row.captureFormatVersion,
        });
        if (loaded.kind === "packets") {
          return c.json({ error: "MoTeC sessions use canonical packets and have no BIN capture" }, 409);
        }
        bytes = loaded.buffer;
      }
    } catch (error) {
      if (bundled) return c.json({ error: error instanceof Error ? error.message : "Invalid lap capture bundle" }, 422);
      return c.json({ error: "Raw capture file is missing on disk" }, 410);
    }
    bytes = new Uint8Array(await gzipAsync(Buffer.from(bytes)));

    const trackName = tryGetGame(row.gameId)?.getTrackName?.(row.trackId ?? "");
    const slug = (trackName || `track${row.trackId ?? ""}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    // Filename MUST start with `<gameId>-` so re-import can detect the game.
    const filename = `${row.gameId}-${slug}-session${row.sessionId}${bundled ? `-lap${row.lapNumber}` : ""}.bin.gz`;

    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    c.header("Content-Length", String(bytes.byteLength));
    return c.body(bytes.slice().buffer as ArrayBuffer);
  })

  .patch("/api/laps/:id/notes", zValidator("param", IdParamSchema), zValidator("json", z.object({ notes: z.string().nullable() })), async (c) => {
    const { id } = c.req.valid("param");
    await updateLapNotes(id, c.req.valid("json").notes);
    return c.json({ ok: true });
  })
  .patch("/api/laps/:id/favorite", zValidator("param", IdParamSchema), zValidator("json", z.object({ favorite: z.boolean() }).strict()), async (c) => {
    const { id } = c.req.valid("param");
    const { favorite } = c.req.valid("json");
    if (!await setLapFavorite(id, favorite)) return c.json({ error: "Lap not found" }, 404);
    return c.json({ ok: true, lapId: id, favorite });
  })

  .post(
    "/api/laps/:id/experiment-excluded",
    zValidator("param", IdParamSchema),
    zValidator("json", z.object({ excluded: z.boolean() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { excluded } = c.req.valid("json");
      const { ok, prev, experimentId } = await setLapExperimentExcluded(id, excluded);
      if (!ok) return c.json({ error: "Lap not found" }, 404);

      // Best-effort: an action-log write failure must not fail the request —
      // the lap flag is already committed. Only log when the lap is linked
      // to a tuning session (laps outside a tuning session have nothing to undo into).
      if (experimentId != null) {
        try {
          await recordAction(experimentId, "set-lap-excluded", { lapId: id, prevExcluded: prev });
        } catch (err: any) {
          console.error("[LapRoutes] Failed to log set-lap-excluded action:", err?.message);
        }
      }

      return c.json({ ok: true, lapId: id, excluded });
    },
  )

  .post("/api/laps/:id/recheck", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);

    const quality = assessLapRecording(lap.telemetry, lap.lapTime);

    // Recompute sector times
    const packets = lap.telemetry;
    let sectors: number[] | null = null;
    if (packets.length >= 50 && lap.trackId) {
      sectors = await computeLapSectors(
        lap.trackId,
        lap.gameId as GameId,
        packets,
        lap.lapTime,
        { sectors: resolveTrack(lap.gameId, lap.trackId).sectors },
      );
    }

    await updateLapValidity(id, quality.valid, quality.valid ? null : quality.reason, sectors);
    return c.json({ id, valid: quality.valid, reason: quality.reason, sectors });
  })

  .delete("/api/laps/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const deleted = await deleteLap(id);
    if (!deleted) return c.json({ error: "Lap not found" }, 404);
    return c.json({ success: true });
  })

  .delete("/api/laps", async (c) => {
    const laps = await getLaps();
    let count = 0;
    for (const lap of laps) {
      if (await deleteLap(lap.id)) count++;
    }
    return c.json({ deleted: count });
  });
