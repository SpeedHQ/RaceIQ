import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { getAccCarByModel } from "../../../shared/racing/cars/acc"
import { getAccTrackByName } from "../../../shared/racing/tracks/catalogs/acc"
import { getAcEvoCarByDisplayName } from "../../../shared/racing/cars/ac-evo"
import { getAcEvoTrackByName } from "../../../shared/racing/tracks/catalogs/ac-evo"
import { getGame } from "../../../shared/games/registry";
import { KNOWN_GAME_IDS } from "../../../shared/games/ids";
import { parseAccBuffers } from "../../games/acc/parser";
import { STATIC } from "../../games/acc/structs";
import { readWString } from "../../games/acc/utils";
import { createAcEvoParserCache, parseAcEvoBuffers } from "../../games/ac-evo/parser";
import { GRAPHICS_EVO, STATIC_EVO } from "../../games/ac-evo/structs";
import { readCString } from "../../games/ac-evo/utils";
import { readKunosFrames } from "../../games/kunos/frame-reader";
import { getAllServerGames } from "../../games/registry";
import {
  ACC_PACKED_MAGIC,
  ACEVO_PACKED_MAGIC,
  packTriplet,
} from "../../games/kunos/pack-triplet";
import { LiveTelemetryPipeline } from "../../telemetry/live-pipeline";
import { NullWsAdapter } from "../../telemetry/pipeline-ports";
import { detectGameIdFromFilename } from "../../session-capture/import-capture";
import { ImportCaptureAdapter } from "../../session-capture/import-pipeline";

export const importRoutes = new Hono();

importRoutes.post("/api/dev/import-dump", async (c) => {
  let tmpPath: string | null = null;

  try {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Missing 'file' in multipart body" }, 400);
    }

    const uploadName = file.name || "upload.bin";
    const lowerName = uploadName.toLowerCase();
    if (!lowerName.endsWith(".bin") && !lowerName.endsWith(".bin.gz")) {
      return c.json({ error: "Expected a .bin or .bin.gz file" }, 400);
    }

    const gameId = detectGameIdFromFilename(uploadName);
    if (!gameId) {
      return c.json(
        {
          error: `Could not detect gameId from filename "${uploadName}". Expected prefix: ${KNOWN_GAME_IDS.join(", ")}.`,
        },
        400
      );
    }

    tmpPath = resolve(
      tmpdir(),
      `raceiq-dump-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`
    );
    const arrayBuf = await file.arrayBuffer();
    let bytes = Buffer.from(arrayBuf);
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      bytes = Buffer.from(gunzipSync(bytes));
    }
    writeFileSync(tmpPath, bytes);

    let packetCount = 0;
    let carModel: string | null = null;
    let trackName: string | null = null;

    const db = new ImportCaptureAdapter();
    const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
      bypassPacketRateFilter: true,
    });
    const start = Date.now();

    if (gameId === "acc") {
      let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
      try {
        frames = readKunosFrames(tmpPath);
      } catch (e) {
        return c.json({ error: "Failed to read ACC frames", details: String(e) }, 400);
      }
      let carOrdinal = 0;
      let trackOrdinal = 0;
      for (const frame of frames) {
        if (carOrdinal === 0 || trackOrdinal === 0) {
          const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
          const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
          if (cm) {
            carModel = cm;
            carOrdinal = getAccCarByModel(cm)?.id ?? 0;
          }
          if (tn) {
            trackName = tn;
            trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
          }
        }
        const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
          carOrdinal,
          trackOrdinal,
        });
        if (!packet) continue;
        const sourceFrame = packTriplet(
          ACC_PACKED_MAGIC,
          packet.CarOrdinal,
          packet.TrackOrdinal ?? 0,
          frame.physics,
          frame.graphics,
          frame.staticData
        );
        await pipeline.processPacket(packet, sourceFrame);
        packetCount++;
      }
    } else if (gameId === "ac-evo") {
      let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
      try {
        frames = readKunosFrames(tmpPath);
      } catch (e) {
        return c.json({ error: "Failed to read AC Evo frames", details: String(e) }, 400);
      }
      const cache = createAcEvoParserCache();
      for (const frame of frames) {
        if (!carModel && frame.graphics.length >= GRAPHICS_EVO.car_model.offset + GRAPHICS_EVO.car_model.size) {
          const cm = readCString(frame.graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size);
          if (cm) {
            carModel = cm;
            const car = getAcEvoCarByDisplayName(cm);
            if (car) cache.carOrdinal = car.id;
          }
        }
        if (!trackName && frame.staticData.length >= STATIC_EVO.track.offset + STATIC_EVO.track.size) {
          const tn = readCString(frame.staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size);
          if (tn) {
            trackName = tn;
            const track = getAcEvoTrackByName(tn);
            if (track) cache.trackOrdinal = track.id;
          }
        }
        const packet = parseAcEvoBuffers(frame.physics, frame.graphics, frame.staticData, cache);
        if (!packet) continue;
        const sourceFrame = packTriplet(
          ACEVO_PACKED_MAGIC,
          packet.CarOrdinal,
          packet.TrackOrdinal ?? -1,
          frame.physics,
          frame.graphics,
          frame.staticData
        );
        await pipeline.processPacket(packet, sourceFrame);
        packetCount++;
      }
    } else {
      const serverAdapter = getAllServerGames().find((a) => a.id === gameId);
      if (!serverAdapter) {
        return c.json({ error: `No server adapter for gameId ${gameId}` }, 400);
      }
      const parserState = serverAdapter.createParserState?.() ?? null;
      const buffer = readFileSync(tmpPath);
      let offset = 0;
      while (offset + 4 <= buffer.length) {
        const len = buffer.readUInt32LE(offset);
        offset += 4;
        if (offset + len > buffer.length) break;
        const sourceFrame = buffer.slice(offset, offset + len);
        const packet = serverAdapter.tryParse(sourceFrame, parserState);
        if (packet) {
          await pipeline.processPacket(packet, sourceFrame);
          packetCount++;
        }
        offset += len;
      }
    }

    if (packetCount === 0) {
      return c.json({ error: "No packets found in dump" }, 400);
    }

    await pipeline.flushIncompleteLap();
    await new Promise<void>((r) => setTimeout(r, 100));
    const elapsedMs = Date.now() - start;

    try {
      unlinkSync(tmpPath);
      tmpPath = null;
    } catch {
      // Best-effort temp cleanup.
    }

    const routePrefix = getGame(gameId).routePrefix;

    return c.json({
      ok: true,
      filename: uploadName,
      gameId,
      routePrefix,
      packetCount,
      carModel,
      trackName,
      elapsedMs,
      laps: db.laps,
    });
  } catch (e) {
    console.error("[dev] import-dump failed:", e);
    if (tmpPath) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort temp cleanup.
      }
    }
    return c.json({ error: "Import failed", details: String(e) }, 500);
  }
});
