import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readKunosFrames, type KunosRecordingFrame } from "../../games/kunos/frame-reader";
export type { KunosRecordingFrame } from "../../games/kunos/frame-reader";
import { parseAccBuffers } from "../../games/acc/parser";
import { readWString } from "../../games/acc/utils";
import { STATIC } from "../../games/acc/structs";
import { getAccCarByModel } from "../../../shared/racing/cars/acc";
import { getAccTrackByName } from "../../../shared/racing/tracks/catalogs/acc";
import { type GameId, KNOWN_GAME_IDS } from "../../../shared/games/ids";
import { readRecordedTelemetry } from "../../session-capture/replay-packets";

export type E2eRecordingFile = {
  name: string;
  path: string;
  size: number;
  modified: number;
};

export type Point2D = { x: number; y: number };
export type Point3D = { x: number; y: number; speed: number };

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
  | {
      ok: false;
      status: 400 | 403 | 404;
      error: "Invalid filename" | "Access denied" | "Recording not found";
    };

const ARTIFACTS_DIR = resolve(process.env.RACEIQ_APP_ROOT ?? process.cwd(), "test/artifacts/sessions");
const RECORDING_GAME_IDS = [...KNOWN_GAME_IDS].sort(
  (left, right) => right.length - left.length,
);

export function resolveRecordingPath(recordingName: string): RecordingPathValidation {
  if (
    recordingName.length === 0 ||
    recordingName.includes("..") ||
    recordingName.includes("/") ||
    recordingName.includes("\\")
  ) {
    return { ok: false, error: "Invalid filename", status: 400 };
  }

  const candidates = [
    resolve(ARTIFACTS_DIR, `${recordingName}.bin`),
    resolve(ARTIFACTS_DIR, `${recordingName}.bin.gz`),
  ];
  if (candidates.some((candidate) => !candidate.startsWith(ARTIFACTS_DIR))) {
    return { ok: false, error: "Access denied", status: 403 };
  }

  const path = candidates.find((candidate) => existsSync(candidate));
  return path
    ? { ok: true, path }
    : { ok: false, error: "Recording not found", status: 404 };
}

export function resolveRecordingGameId(recordingName: string): GameId | null {
  const normalizedName = recordingName.startsWith("session-")
    ? recordingName.slice("session-".length)
    : recordingName;
  return (
    RECORDING_GAME_IDS.find(
      (gameId) =>
        normalizedName === gameId || normalizedName.startsWith(`${gameId}-`),
    ) ?? null
  );
}

export function listE2eRecordings(): E2eRecordingFile[] {
  const files: E2eRecordingFile[] = [];

  const entries = readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      (!entry.name.endsWith(".bin") && !entry.name.endsWith(".bin.gz"))
    ) {
      continue;
    }

    const filePath = resolve(ARTIFACTS_DIR, entry.name);
    const stat = statSync(filePath);
    const displayName = entry.name.replace(/\.bin(?:\.gz)?$/, "");
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
      timestampMS: frame.timestampMS,
    });

    if (packet) {
      packets.push({ x: packet.PositionX, y: packet.PositionZ });
    }
  }

  return packets;
}

export function parseUdpRecordingPoints(gameId: GameId, binPath: string): Point2D[] {
  return readRecordedTelemetry(gameId, binPath).packets.map((packet) => ({
    x: packet.PositionX,
    y: packet.PositionZ,
  }));
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
      timestampMS: frame.timestampMS,
    });

    if (packet) {
      packets.push({ x: packet.PositionX, y: packet.PositionZ, speed: packet.Speed });
    }
  }

  return packets;
}

export function parseUdpRecordingPacketsWithSpeed(
  gameId: GameId,
  binPath: string,
): Point3D[] {
  return readRecordedTelemetry(gameId, binPath).packets.map((packet) => ({
    x: packet.PositionX,
    y: packet.PositionZ,
    speed: packet.Speed,
  }));
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
      timestampMS: frame.timestampMS,
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

export function parseUdpRecordingLaps(
  gameId: GameId,
  binPath: string,
): E2eLapResult {
  const lapRanges = new Map<
    number,
    { start: number; end: number; lapTime: number; maxCurrentLap: number }
  >();
  let packetIndex = 0;
  let currentLap = -1;

  for (const packet of readRecordedTelemetry(gameId, binPath).packets) {
    if (packet.LapNumber !== undefined) {
      if (packet.LapNumber !== currentLap) {
        if (currentLap !== -1) {
          const prevLapRange = lapRanges.get(currentLap);
          if (prevLapRange) {
            prevLapRange.lapTime =
              (packet.LastLap ?? 0) > 0
                ? (packet.LastLap ?? 0)
                : prevLapRange.maxCurrentLap;
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
          range.maxCurrentLap = Math.max(
            range.maxCurrentLap,
            packet.CurrentLap ?? 0,
          );
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
