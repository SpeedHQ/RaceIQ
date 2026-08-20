import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";

import { IdParamSchema } from "@shared/platform/http/route-schemas";
import { GameIdSchema, type GameId } from "../../../shared/games/ids";
import { getAllGames, getGame, tryGetGame } from "../../../shared/games/registry";
import { requiredSemanticIds } from "../../../shared/games/metric-contracts";
import { analyzeLap } from "../../../shared/racing/analysis/laps/insights/analyze";
import { downsampleLap } from "../../../shared/racing/laps/trace/build";
import { encodeLapTrace } from "../../../shared/racing/laps/trace/codec";
import type { EncodedLapTrace } from "../../../shared/racing/laps/trace/types";
import { getLaps, getLapById, getLapsByIds, getLapsRaw } from "../../db/lap-read-queries";
import { deleteLap, updateLapNotes, updateLapValidity } from "../../db/lap-mutation-queries";
import { setLapExperimentExcluded } from "../../db/experiment-lap-queries";
import { recordAction } from "../../db/experiment-action-queries";
import { assessLapRecording } from "../../lap-analysis/quality";
import { computeNativeSectorTimeline, computeLapSectors, isValidNativeSectorStarts } from "../../lap-analysis/sectors";
import { generateExport } from "../../lap-analysis/report";
import { resolveTrack } from "../../tracks/info";
import { resolveLapGeoreference } from "../../tracks/georeference";
import { queryLapTelemetryBySemanticId } from "../../telemetry/replay";
import { BulkDeleteSchema, LapsQuerySchema } from "./support";

export function semanticReplayIds(): readonly string[] {
  return [...new Set([
    ...getAllGames().flatMap((adapter) => requiredSemanticIds(adapter)),
    "engine.current-engine-rpm",
    "inputs.gear",
    "inputs.throttle",
    "inputs.brake",
    "inputs.steering",
    "motion.speed",
    "motion.acceleration-x",
    "motion.angular-velocity-y",
    "motion.pitch",
    "motion.roll",
    "motion.position-x",
    "motion.position-z",
    "motion.yaw",
    "timing.current-lap",
    "timing.current-race-time",
    "timing.distance-traveled",
    "timing.lap-fraction",
    "aero.drs-active",
    "weather.air-temp",
    "fuel.ers-store-energy",
    "fuel.ers-deploy-mode",
    "brakes.brake-bias",
    "fuel.ers-deployed",
    "fuel.ers-harvested",
    "fuel.capacity",
    "fuel.remaining-fraction",
    "fuel.remaining-percent",
    "fuel.remaining-volume",
    "identity.car-ordinal",
    "identity.player-track-surface",
    "tires.tire-radius",
  ])];
}
const timestampMilliseconds = (timestamp: { domain: string; milliseconds?: number; nanoseconds?: bigint }) =>
  timestamp.domain === "monotonic" ? Number(timestamp.nanoseconds ?? 0n) / 1_000_000 : timestamp.milliseconds ?? 0;
const gzipAsync = promisify(gzip);

export const resourceRoutes = new Hono()
  .get("/api/laps", zValidator("query", LapsQuerySchema), async (c) => {
    const { gameId } = c.req.valid("query");
    const lapList = await getLaps(gameId);
    return c.json(lapList);
  })

  .get("/api/laps/:id/semantic-telemetry", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const gameIdResult = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameIdResult.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    try {
      const lap = await getLapById(id);
      if (!lap || lap.gameId !== gameIdResult.data) return c.json({ error: "Lap not found" }, 404);
      const replay = await queryLapTelemetryBySemanticId(id, semanticReplayIds());
      if (!replay) return c.json({ error: "Lap not found" }, 404);
      const game = getGame(lap.gameId);
      const nativeLayout = game.nativeSectors
        ? lap.telemetry
          .map((packet) => game.getNativeSectorLayout?.(packet))
          .find((layout) => isValidNativeSectorStarts(layout?.starts))
        : undefined;
      const trackOrdinal = lap.trackOrdinal;
      const georeference = trackOrdinal == null
        ? null
        : await resolveLapGeoreference({
            canonicalSlug: game.getSharedTrackName?.(trackOrdinal),
            gameId: lap.gameId,
            trackOrdinal,
            packets: lap.telemetry,
          });
      return c.json({
        lapId: replay.lapId,
        requestedSemanticIds: replay.requestedSemanticIds,
        sectorTimes: lap.sectorTimes ?? null,
        sectorStarts: nativeLayout?.starts ?? null,
        insights: analyzeLap(lap.telemetry, lap.gameId),
        ...(georeference
          ? {
              geographicPositions: georeference.positions,
              georeference: georeference.metadata,
            }
          : {}),
        envelopes: replay.envelopes.map((envelope) => ({
          sequence: Number(envelope.sequence),
          observedAt: { domain: "wall-clock", milliseconds: timestampMilliseconds(envelope.observedAt) },
          receivedAt: { domain: "wall-clock", milliseconds: timestampMilliseconds(envelope.receivedAt) },
          simulator: envelope.simulator,
          values: envelope.values.map(({ semanticId, value, state, freshness }) => ({ semanticId, value, state, freshness })),
        })),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to replay telemetry" }, 422);
    }
  })

  .post("/api/laps/bulk-delete", zValidator("json", BulkDeleteSchema), async (c) => {
    const { ids } = c.req.valid("json");
    let count = 0;
    for (const id of ids) {
      if (await deleteLap(id)) count++;
    }
    return c.json({ deleted: count });
  })

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
    const insights = analyzeLap(packets, gameId);

    return c.json({ ...lap, sectorTimes, insights });
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

  .patch("/api/laps/:id/notes", zValidator("param", IdParamSchema), zValidator("json", z.object({ notes: z.string().nullable() })), async (c) => {
    const { id } = c.req.valid("param");
    await updateLapNotes(id, c.req.valid("json").notes);
    return c.json({ ok: true });
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
    if (packets.length >= 50 && lap.gameId && lap.trackOrdinal != null) {
      sectors = await computeLapSectors(
        lap.trackOrdinal,
        lap.gameId as GameId,
        packets,
        lap.lapTime,
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
