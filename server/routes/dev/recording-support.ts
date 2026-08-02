import { readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { parsePacket } from "../../parsers/index";
import { readKunosFrames } from "../../games/kunos/frame-reader";
import { parseAccBuffers } from "../../games/acc/parser";
import { readWString } from "../../games/acc/utils";
import { STATIC } from "../../games/acc/structs";
import { getAccCarByModel } from "../../../shared/acc-car-data";
import { getAccTrackByName } from "../../../shared/acc-track-data";
import { type GameId } from "../../../shared/types";

export type E2eRecordingFile = {
  name: string;
  path: string;
  size: number;
  modified: number;
};

export type Point2D = { x: number; y: number };
export type Point3D = { x: number; y: number; speed: number };
export type KunosRecordingFrame = {
  physics: Buffer;
  graphics: Buffer;
  staticData: Buffer;
};

export type E2eLap = {
  lapNumber: number;
  startPacketIndex: number;
  endPacketIndex: number;
  lapTime: number;
  isValid: boolean;
};

export interface E2eLapResult {
  laps: E2eLap[];
  totalPackets: number;
}

export type RecordingPathValidation =
  | { ok: true; path: string }
  | { ok: false; status: 400 | 403; error: "Invalid filename" | "Access denied" };

const ARTIFACTS_DIR = resolve(process.cwd(), "test/artifacts/sessions");

export function resolveRecordingPath(recordingName: string): RecordingPathValidation {
  if (recordingName.includes("..") || recordingName.startsWith("/")) {
    return { ok: false, error: "Invalid filename", status: 400 };
  }

  const binPath = resolve(ARTIFACTS_DIR, `${recordingName}.bin`);

  if (!binPath.startsWith(ARTIFACTS_DIR)) {
    return { ok: false, error: "Access denied", status: 403 };
  }

  return { ok: true, path: binPath };
}

export function resolveRecordingGameId(recordingName: string): GameId {
  return recordingName.split("-").slice(0, 1).join("-") as GameId;
}

export function listE2eRecordings(): E2eRecordingFile[] {
  const files: E2eRecordingFile[] = [];

  const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".bin")) continue;

    const filePath = resolve(ARTIFACTS_DIR, entry.name);
    const stat = statSync(filePath);
    const displayName = entry.name.replace(".bin", "");
    files.push({
      name: displayName,
      path: filePath,
      size: stat.size,
      modified: stat.mtimeMs,
    });
  }

  return files.sort((a, b) => b.modified - a.modified);
}

export function readAccRecordingFrames(binPath: string): KunosRecordingFrame[] {
  return readKunosFrames(binPath);
}

export function parseAccRecordingPoints(frames: KunosRecordingFrame[]): Point2D[] {
  const packets: Point2D[] = [];

  let carOrdinal = 0;
  let trackOrdinal = 0;

  for (const frame of frames) {
    if (carOrdinal === 0 || trackOrdinal === 0) {
      const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
      if (cm) {
        carOrdinal = getAccCarByModel(cm)?.id ?? 0;
      }
      if (tn) {
        trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
      }
    }

    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
      carOrdinal,
      trackOrdinal,
    });

    if (packet) {
      packets.push({ x: packet.PositionX, y: packet.PositionZ });
    }
  }

  return packets;
}

export function parseUdpRecordingPoints(binPath: string): Point2D[] {
  const packets: Point2D[] = [];
  const buffer = readFileSync(binPath);
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    offset += 4;
    if (offset + len > buffer.length) break;

    const chunk = buffer.slice(offset, offset + len);
    const packet = parsePacket(chunk);

    if (packet) {
      packets.push({ x: packet.PositionX, y: packet.PositionZ });
    }

    offset += len;
  }

  return packets;
}

export function parseAccRecordingPacketsWithSpeed(frames: KunosRecordingFrame[]): Point3D[] {
  const packets: Point3D[] = [];

  let carOrdinal = 0;
  let trackOrdinal = 0;

  for (const frame of frames) {
    if (carOrdinal === 0 || trackOrdinal === 0) {
      const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
      if (cm) {
        carOrdinal = getAccCarByModel(cm)?.id ?? 0;
      }
      if (tn) {
        trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
      }
    }

    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
      carOrdinal,
      trackOrdinal,
    });

    if (packet) {
      packets.push({ x: packet.PositionX, y: packet.PositionZ, speed: packet.Speed });
    }
  }

  return packets;
}

export function parseUdpRecordingPacketsWithSpeed(binPath: string): Point3D[] {
  const packets: Point3D[] = [];
  const buffer = readFileSync(binPath);
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    offset += 4;
    if (offset + len > buffer.length) break;

    const chunk = buffer.slice(offset, offset + len);
    const packet = parsePacket(chunk);

    if (packet) {
      packets.push({ x: packet.PositionX, y: packet.PositionZ, speed: packet.Speed });
    }

    offset += len;
  }

  return packets;
}

export function parseAccRecordingLaps(frames: KunosRecordingFrame[]): E2eLapResult {
  const lapRanges = new Map<number, { start: number; end: number; lapTime: number; maxCurrentLap: number }>();
  let packetIndex = 0;
  let currentLap = -1;
  let carOrdinal = 0;
  let trackOrdinal = 0;

  for (const frame of frames) {
    if (carOrdinal === 0 || trackOrdinal === 0) {
      const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
      if (cm) {
        carOrdinal = getAccCarByModel(cm)?.id ?? 0;
      }
      if (tn) {
        trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
      }
    }

    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
      carOrdinal,
      trackOrdinal,
    });

    if (packet && packet.LapNumber !== undefined) {
      if (packet.LapNumber !== currentLap) {
        if (currentLap !== -1) {
          const prevLapRange = lapRanges.get(currentLap);
          if (prevLapRange) {
            prevLapRange.lapTime = (packet.LastLap ?? 0) > 0 ? (packet.LastLap ?? 0) : prevLapRange.maxCurrentLap;
          }
        }

        if (!lapRanges.has(packet.LapNumber)) {
          lapRanges.set(packet.LapNumber, {
            start: packetIndex,
            end: packetIndex,
            lapTime: 0,
            maxCurrentLap: 0,
          });
        } else {
          const range = lapRanges.get(packet.LapNumber);
          if (range) {
            range.end = packetIndex;
          }
        }

        currentLap = packet.LapNumber;
      } else {
        const range = lapRanges.get(packet.LapNumber);
        if (range) {
          range.end = packetIndex;
          range.maxCurrentLap = Math.max(range.maxCurrentLap, packet.CurrentLap ?? 0);
        }
      }
    }

    packetIndex++;
  }

  const laps = Array.from(lapRanges.entries())
    .map(([lapNumber, range]) => ({
      lapNumber,
      startPacketIndex: range.start,
      endPacketIndex: range.end,
      lapTime: range.lapTime,
      isValid: true,
    }))
    .sort((a, b) => a.lapNumber - b.lapNumber);

  return {
    laps,
    totalPackets: packetIndex,
  };
}

export function parseUdpRecordingLaps(binPath: string): E2eLapResult {
  const lapRanges = new Map<number, { start: number; end: number; lapTime: number; maxCurrentLap: number }>();
  let packetIndex = 0;
  let currentLap = -1;

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
        if (currentLap !== -1) {
          const prevLapRange = lapRanges.get(currentLap);
          if (prevLapRange) {
            prevLapRange.lapTime = (packet.LastLap ?? 0) > 0 ? (packet.LastLap ?? 0) : prevLapRange.maxCurrentLap;
          }
        }

        if (!lapRanges.has(packet.LapNumber)) {
          lapRanges.set(packet.LapNumber, {
            start: packetIndex,
            end: packetIndex,
            lapTime: 0,
            maxCurrentLap: 0,
          });
        } else {
          const range = lapRanges.get(packet.LapNumber);
          if (range) {
            range.end = packetIndex;
          }
        }

        currentLap = packet.LapNumber;
      } else {
        const range = lapRanges.get(packet.LapNumber);
        if (range) {
          range.end = packetIndex;
          range.maxCurrentLap = Math.max(range.maxCurrentLap, packet.CurrentLap ?? 0);
        }
      }
    }

    packetIndex++;
    offset += len;
  }

  const laps = Array.from(lapRanges.entries())
    .map(([lapNumber, range]) => ({
      lapNumber,
      startPacketIndex: range.start,
      endPacketIndex: range.end,
      lapTime: range.lapTime,
      isValid: true,
    }))
    .sort((a, b) => a.lapNumber - b.lapNumber);

  return {
    laps,
    totalPackets: packetIndex,
  };
}

export function generateTrackSVG(packets: Point2D[]): string {
  if (packets.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="10" y="30" fill="#999">No packets</text></svg>';
  }

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
