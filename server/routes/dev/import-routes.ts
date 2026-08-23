import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getAccCarByModel } from "../../../shared/racing/cars/acc"
import { getAccTrackByName } from "../../../shared/racing/tracks/catalogs/acc"
import { getGame } from "../../../shared/games/registry";
import { KNOWN_GAME_IDS } from "../../../shared/games/ids";
import { STATIC } from "../../games/acc/structs";
import { readWString } from "../../games/acc/utils";
import { GRAPHICS_EVO, STATIC_EVO } from "../../games/ac-evo/structs";
import { readCString } from "../../games/ac-evo/utils";
import { readKunosFrames } from "../../games/kunos/frame-reader";
import { tryGetServerGame } from "../../games/registry";
import {
  ACC_PACKED_MAGIC,
  ACEVO_PACKED_MAGIC,
  packTriplet,
} from "../../games/kunos/pack-triplet";
import { importSessionFrames } from "../../session-capture/import-pipeline";
import { detectGameIdFromFilename } from "../../session-capture/import-capture";
import { OwnershipSchema } from "../laps/support";

import { MAX_RAW_CAPTURE_BUFFERED_BYTES, MAX_RAW_CAPTURE_EXPANDED_BYTES } from "../../session-capture/identity";

class ImportUploadLimitError extends Error {}

function byteLimit(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) {
        throw new ImportUploadLimitError(`Import exceeds ${limit} byte processing limit`);
      }
      controller.enqueue(chunk);
    },
  });
}

export const importRoutes = new Hono();

importRoutes.post("/api/dev/import-dump", async (c) => {
  let tmpPath: string | null = null;

  try {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Missing 'file' in multipart body" }, 400);
    }
    const ownership = OwnershipSchema.safeParse(form?.get("ownership"));
    if (!ownership.success) {
      return c.json({ error: "ownership must be exactly mine or others" }, 400);
    }

    const uploadName = file.name || "upload.bin";
    const lowerName = uploadName.toLowerCase();
    if (!lowerName.endsWith(".bin") && !lowerName.endsWith(".bin.gz")) {
      return c.json({ error: "Expected a .bin or .bin.gz file" }, 400);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_RAW_CAPTURE_BUFFERED_BYTES) {
      return c.json({ error: `Upload exceeds the ${MAX_RAW_CAPTURE_BUFFERED_BYTES / 1024 ** 2} MiB limit` }, 413);
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
    const header = Buffer.from(await file.slice(0, 2).arrayBuffer());
    const source = header[0] === 0x1f && header[1] === 0x8b
      ? file.stream().pipeThrough(new DecompressionStream("gzip")).pipeThrough(byteLimit(MAX_RAW_CAPTURE_EXPANDED_BYTES))
      : file.stream().pipeThrough(byteLimit(MAX_RAW_CAPTURE_BUFFERED_BYTES));
    await Bun.write(tmpPath, new Response(source));

    let packetCount = 0;
    let carModel: string | null = null;
    let trackName: string | null = null;
    const start = Date.now();

    if (!tryGetServerGame(gameId)) {
      return c.json({ error: `No server adapter for gameId ${gameId}`, code: "NO_SERVER_ADAPTER" }, 400);
    }

    let sourceFrames: Iterable<Buffer>;
    if (gameId === "acc") {
      let frames;
      try {
        frames = readKunosFrames(tmpPath);
      } catch (error) {
        return c.json({ error: "Failed to read ACC frames", details: String(error) }, 400);
      }
      sourceFrames = (function*() {
        let carOrdinal = 0;
        let trackOrdinal = 0;
        for (const frame of frames) {
          if (carOrdinal === 0 || trackOrdinal === 0) {
            const car = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
            const track = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
            if (car) {
              carModel = car;
              carOrdinal = getAccCarByModel(car)?.id ?? 0;
            }
            if (track) {
              trackName = track;
              trackOrdinal = getAccTrackByName(track)?.id ?? 0;
            }
          }
          yield packTriplet(
            ACC_PACKED_MAGIC,
            carOrdinal,
            trackOrdinal,
            frame.physics,
            frame.graphics,
            frame.staticData,
            frame.timestampMS,
          );
        }
      })();
    } else if (gameId === "ac-evo") {
      let frames;
      try {
        frames = readKunosFrames(tmpPath);
      } catch (error) {
        return c.json({ error: "Failed to read AC Evo frames", details: String(error) }, 400);
      }
      sourceFrames = (function*() {
        for (const frame of frames) {
          if (!carModel && frame.graphics.length >= GRAPHICS_EVO.car_model.offset + GRAPHICS_EVO.car_model.size) {
            carModel = readCString(frame.graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size) || null;
          }
          if (!trackName && frame.staticData.length >= STATIC_EVO.track.offset + STATIC_EVO.track.size) {
            trackName = readCString(frame.staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size) || null;
          }
          yield packTriplet(
            ACEVO_PACKED_MAGIC,
            0,
            -1,
            frame.physics,
            frame.graphics,
            frame.staticData,
            frame.timestampMS,
          );
        }
      })();
    } else {
      const buffer = readFileSync(tmpPath);
      sourceFrames = (function*() {
        let offset = 0;
        while (offset < buffer.length) {
          if (offset + 4 > buffer.length) throw new Error("Import frame length is truncated");
          const length = buffer.readUInt32LE(offset);
          offset += 4;
          if (offset + length > buffer.length) throw new Error("Import frame payload is truncated");
          yield buffer.subarray(offset, offset + length);
          offset += length;
        }
      })();
    }

    const imported = await importSessionFrames(sourceFrames, gameId, {
      ownership: ownership.data,
      sourceKind: "raceiq-raw",
    });
    packetCount = imported.packetCount;
    if (packetCount === 0) {
      return c.json({ error: "No packets found in dump" }, 400);
    }

    const elapsedMs = Date.now() - start;
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
      laps: imported.laps,
    });
  } catch (e) {
    console.error("[dev] import-dump failed:", e);
    if (e instanceof ImportUploadLimitError) {
      return c.json({ error: e.message }, 413);
    }
    return c.json({ error: "Import failed", details: String(e) }, 500);
  } finally {
    if (tmpPath) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort temp cleanup.
      }
    }
  }
});
