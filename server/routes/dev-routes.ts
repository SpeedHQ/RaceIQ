import { Hono } from "hono";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { parsePacket } from "../parsers/index";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../games/init";
import { readAccFrames } from "../games/acc/recorder";
import { parseAccBuffers } from "../games/acc/parser";
import { readWString } from "../games/acc/utils";
import { STATIC } from "../games/acc/structs";
import { getAccCarByModel } from "../../shared/acc-car-data";
import { getAccTrackByName } from "../../shared/acc-track-data";
import type { GameId } from "../../shared/types";

const ARTIFACTS_DIR = resolve(process.cwd(), "test/artifacts/laps");

// Initialize game adapters on module load
initGameAdapters();
initServerGameAdapters();

export const devRoutes = new Hono();

/**
 * GET /api/dev/e2e-files
 * List all .bin recording files from test/artifacts/laps
 */
devRoutes.get("/api/dev/e2e-files", (c) => {
  try {
    const files: Array<{ name: string; path: string; size: number; modified: number }> = [];

    // Scan test/artifacts/laps for .bin files
    const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".bin")) continue;

      const filePath = resolve(ARTIFACTS_DIR, entry.name);
      const stat = statSync(filePath);
      const displayName = entry.name.replace(".bin", ""); // Remove .bin extension
      files.push({
        name: displayName,
        path: filePath,
        size: stat.size,
        modified: stat.mtimeMs,
      });
    }

    return c.json({ files: files.sort((a, b) => b.modified - a.modified) });
  } catch (e) {
    return c.json(
      { error: "Failed to list E2E files", details: String(e) },
      500
    );
  }
});

/**
 * GET /api/dev/e2e-svg/:recordingName
 * Generate SVG from .bin recording by parsing packets and drawing track path
 */
devRoutes.get("/api/dev/e2e-svg/:recordingName", (c) => {
  try {
    const recordingName = c.req.param("recordingName");

    // Prevent path traversal attacks
    if (recordingName.includes("..") || recordingName.startsWith("/")) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    // Look for .bin file in artifacts
    const binPath = resolve(ARTIFACTS_DIR, `${recordingName}.bin`);

    // Ensure the file is within ARTIFACTS_DIR
    if (!binPath.startsWith(ARTIFACTS_DIR)) {
      return c.json({ error: "Access denied" }, 403);
    }

    try {
      const gameId = recordingName.split("-").slice(0, 1).join("-") as GameId;
      const packets: Array<{ x: number; y: number }> = [];

      if (gameId === "acc") {
        // ACC format: shared memory frames
        let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
        try {
          frames = readAccFrames(binPath);
        } catch (e) {
          console.error("Failed to read ACC frames:", e);
          return c.json(
            { error: "Failed to read ACC frames", details: String(e) },
            400
          );
        }

        let carOrdinal = 0;
        let trackOrdinal = 0;
        for (const frame of frames) {
          if (carOrdinal === 0 || trackOrdinal === 0) {
            const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
            const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
            if (cm) { carOrdinal = getAccCarByModel(cm)?.id ?? 0; }
            if (tn) { trackOrdinal = getAccTrackByName(tn)?.id ?? 0; }
          }
          const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
          if (packet) {
            packets.push({
              x: packet.PositionX,
              y: packet.PositionZ,
            });
          }
        }
      } else {
        // UDP dump format: [uint32 LE length][N raw bytes]
        const buffer = readFileSync(binPath);
        let offset = 0;
        while (offset + 4 <= buffer.length) {
          const len = buffer.readUInt32LE(offset);
          offset += 4;
          if (offset + len > buffer.length) break; // truncated final record

          const chunk = buffer.slice(offset, offset + len);
          const packet = parsePacket(chunk);
          if (packet) {
            packets.push({
              x: packet.PositionX,
              y: packet.PositionZ,
            });
          }
          offset += len;
        }
      }

      if (packets.length === 0) {
        return c.json(
          { error: "Failed to parse any packets from recording" },
          400
        );
      }

      // Generate SVG from packets
      const svg = generateTrackSVG(packets);
      return c.html(svg);
    } catch (e) {
      console.error("Failed to parse recording:", e);
      return c.json(
        { error: "Failed to generate SVG", details: String(e) },
        500
      );
    }
  } catch (e) {
    return c.json(
      { error: "Failed to read recording", details: String(e) },
      404
    );
  }
});

/**
 * GET /api/dev/e2e-laps/:recordingName
 * Parse recording and detect lap boundaries by scanning packets for currentLap changes
 */
devRoutes.get("/api/dev/e2e-laps/:recordingName", async (c) => {
  try {
    const recordingName = c.req.param("recordingName");

    // Prevent path traversal attacks
    if (recordingName.includes("..") || recordingName.startsWith("/")) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    // Look for .bin file in artifacts
    const binPath = resolve(ARTIFACTS_DIR, `${recordingName}.bin`);

    // Ensure the file is within ARTIFACTS_DIR
    if (!binPath.startsWith(ARTIFACTS_DIR)) {
      return c.json({ error: "Access denied" }, 403);
    }

    try {
      const gameId = recordingName.split("-").slice(0, 1).join("-") as GameId;
      const lapRanges = new Map<number, { start: number; end: number; lapTime: number }>();
      let packetIndex = 0;
      let currentLap = -1;

      if (gameId === "acc") {
        // ACC format: shared memory frames
        let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
        try {
          frames = readAccFrames(binPath);
        } catch (e) {
          console.error("Failed to read ACC frames:", e);
          return c.json({
            laps: [],
            totalPackets: 0,
          });
        }

        let carOrdinal = 0;
        let trackOrdinal = 0;
        for (const frame of frames) {
          if (carOrdinal === 0 || trackOrdinal === 0) {
            const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
            const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
            if (cm) { carOrdinal = getAccCarByModel(cm)?.id ?? 0; }
            if (tn) { trackOrdinal = getAccTrackByName(tn)?.id ?? 0; }
          }
          const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
          if (packet && packet.LapNumber !== undefined) {
            if (packet.LapNumber !== currentLap) {
              if (!lapRanges.has(packet.LapNumber)) {
                lapRanges.set(packet.LapNumber, { start: packetIndex, end: packetIndex, lapTime: packet.currentLapTime ?? 0 });
              } else {
                const range = lapRanges.get(packet.LapNumber)!;
                range.end = packetIndex;
                range.lapTime = packet.currentLapTime ?? 0;
              }
              currentLap = packet.LapNumber;
            } else {
              const range = lapRanges.get(packet.LapNumber);
              if (range) {
                range.end = packetIndex;
                range.lapTime = packet.currentLapTime ?? 0;
              }
            }
          }
          packetIndex++;
        }
      } else {
        // UDP dump format: [uint32 LE length][N raw bytes]
        const buffer = readFileSync(binPath);
        let offset = 0;

        while (offset + 4 <= buffer.length) {
          const len = buffer.readUInt32LE(offset);
          offset += 4;
          if (offset + len > buffer.length) break;

          const chunk = buffer.slice(offset, offset + len);
          const packet = parsePacket(chunk);

          if (packet && packet.LapNumber !== undefined) {
            if (packet.LapNumber !== currentLap) {
              if (!lapRanges.has(packet.LapNumber)) {
                lapRanges.set(packet.LapNumber, { start: packetIndex, end: packetIndex, lapTime: packet.currentLapTime ?? 0 });
              } else {
                const range = lapRanges.get(packet.LapNumber)!;
                range.end = packetIndex;
                range.lapTime = packet.currentLapTime ?? 0;
              }
              currentLap = packet.LapNumber;
            } else {
              const range = lapRanges.get(packet.LapNumber);
              if (range) {
                range.end = packetIndex;
                range.lapTime = packet.currentLapTime ?? 0;
              }
            }
          }

          packetIndex++;
          offset += len;
        }
      }

      // Convert map to sorted lap array
      const laps = Array.from(lapRanges.entries())
        .map(([lapNumber, range]) => ({
          lapNumber,
          startPacketIndex: range.start,
          endPacketIndex: range.end,
          lapTime: range.lapTime,
          isValid: true,
        }))
        .sort((a, b) => a.lapNumber - b.lapNumber);

      return c.json({
        laps,
        totalPackets: packetIndex,
      });
    } catch (e) {
      console.error("Failed to detect laps:", e);
      return c.json(
        { error: "Failed to detect laps", details: String(e) },
        500
      );
    }
  } catch (e) {
    return c.json(
      { error: "Failed to process recording", details: String(e) },
      404
    );
  }
});

/**
 * Generate SVG visualization of track path from packets
 */
function generateTrackSVG(packets: Array<{ x: number; y: number }>): string {
  if (packets.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="10" y="30" fill="#999">No packets</text></svg>';
  }

  // Calculate bounds
  let minX = packets[0].x,
    maxX = packets[0].x;
  let minY = packets[0].y,
    maxY = packets[0].y;

  for (const p of packets) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const margin = 40;
  const width = 800;
  const height = 600;
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scaleX = (width - 2 * margin) / rangeX;
  const scaleY = (height - 2 * margin) / rangeY;
  const scale = Math.min(scaleX, scaleY);

  // Build path
  let pathData = "";
  for (let i = 0; i < packets.length; i++) {
    const x = margin + (packets[i].x - minX) * scale;
    const y = margin + (packets[i].y - minY) * scale;
    pathData += `${i === 0 ? "M" : "L"} ${x} ${y}`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <style>
    .track { stroke: #4a90e2; stroke-width: 2; fill: none; }
    .packet { fill: #e24a4a; }
  </style>
  <rect width="800" height="600" fill="#1a1a1a"/>
  <path class="track" d="${pathData}"/>
  <circle cx="${margin + (packets[0].x - minX) * scale}" cy="${margin + (packets[0].y - minY) * scale}" r="4" class="packet" opacity="0.8"/>
</svg>`;
}

/**
 * GET /api/dev/e2e-packets/:recordingName
 * Parse .bin recording file and return packet data (positions, speeds)
 * recordingName should be the .bin filename without extension
 */
devRoutes.get("/api/dev/e2e-packets/:recordingName", (c) => {
  try {
    const recordingName = c.req.param("recordingName");

    // Prevent path traversal attacks
    if (recordingName.includes("..") || recordingName.startsWith("/")) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    // Look for .bin file in artifacts
    const binPath = resolve(ARTIFACTS_DIR, `${recordingName}.bin`);

    // Ensure the file is within ARTIFACTS_DIR
    if (!binPath.startsWith(ARTIFACTS_DIR)) {
      return c.json({ error: "Access denied" }, 403);
    }

    try {
      const packets: Array<{ x: number; y: number; speed: number }> = [];
      const gameId = recordingName.split("-").slice(0, 1).join("-") as GameId;

      if (gameId === "acc") {
        // ACC format: shared memory frames
        let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
        try {
          frames = readAccFrames(binPath);
        } catch (e) {
          console.error("Failed to read ACC frames:", e);
          return c.json({
            packetCount: 0,
            packets: [],
          });
        }

        let carOrdinal = 0;
        let trackOrdinal = 0;
        for (const frame of frames) {
          if (carOrdinal === 0 || trackOrdinal === 0) {
            const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
            const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
            if (cm) { carOrdinal = getAccCarByModel(cm)?.id ?? 0; }
            if (tn) { trackOrdinal = getAccTrackByName(tn)?.id ?? 0; }
          }
          const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
          if (packet) {
            packets.push({
              x: packet.PositionX,
              y: packet.PositionZ,
              speed: packet.Speed,
            });
          }
        }
      } else {
        // UDP dump format: [uint32 LE length][N raw bytes]
        const buffer = readFileSync(binPath);
        let offset = 0;
        while (offset + 4 <= buffer.length) {
          const len = buffer.readUInt32LE(offset);
          offset += 4;
          if (offset + len > buffer.length) break; // truncated final record

          const chunk = buffer.slice(offset, offset + len);
          const packet = parsePacket(chunk);

          if (packet) {
            packets.push({
              x: packet.PositionX,
              y: packet.PositionZ,
              speed: packet.Speed,
            });
          }
          offset += len;
        }
      }

      return c.json({
        packetCount: packets.length,
        packets,
      });
    } catch (e) {
      // If parsing fails, return empty
      console.error("Failed to parse recording:", e);
      return c.json({
        packetCount: 0,
        packets: [],
      });
    }
  } catch (e) {
    return c.json(
      { error: "Failed to read packets", details: String(e) },
      404
    );
  }
});
