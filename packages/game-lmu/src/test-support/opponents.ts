import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { decodeLMUSourceFrame, encodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LmuOpponentIdentityTracker } from "@raceiq/capture-formats/lmu/opponent-snapshot";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame } from "@raceiq/capture-formats/session/framing";
import {
  LMU_GAME_VERSION_OFFSET, LMU_SCORING_INFO, LMU_SCORING_INFO_OFFSET,
  LMU_SCORING_VEHICLE, LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLES_OFFSET,
  LMU_SESSION_EVENT_OFFSET, LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY,
  LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET,
} from "@raceiq/capture-formats/lmu/layout";

/** Controlled scoring geometry, not evidence of online LMU channel population. */
export function makeLmuOpponentCapture(options: { identity?: string } = {}): Buffer {
  const identity = options.identity ?? "default";
  const originalBytes = readLMUFramesFromBuffer(gunzipSync(readFileSync(resolve(__dirname, "../../test/fixtures/sessions/lmu-spa-iron-lynx-gte.bin.gz"))))[0]!;
  const original = decodeLMUSourceFrame(originalBytes)!;
  assert(original.playerScoring);
  const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
  memory.writeInt32LE(original.gameVersion, LMU_GAME_VERSION_OFFSET);
  memory.writeUInt32LE(485, LMU_SESSION_EVENT_OFFSET);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
  original.telemetry.copy(memory, LMU_TELEMETRY_INFO_OFFSET);
  original.scoringInfo.copy(memory, LMU_SCORING_INFO_OFFSET);
  const playerOffset = LMU_SCORING_VEHICLES_OFFSET;
  const opponentOffset = playerOffset + LMU_SCORING_VEHICLE_SIZE;
  original.playerScoring.copy(memory, playerOffset);
  original.playerScoring.copy(memory, opponentOffset);
  const text = (offset: number, length: number, value: string) => {
    memory.fill(0, offset, offset + length);
    memory.write(value, offset, length, "utf8");
  };
  text(LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.trackName, 64, identity === "default" ? "RaceIQ Opponent Fixture" : `RaceIQ Opponent Fixture ${identity}`);
  text(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackName, 64, identity === "default" ? "RaceIQ Opponent Fixture" : `RaceIQ Opponent Fixture ${identity}`);
  memory.writeInt32LE(42, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.id);
  memory.writeInt32LE(2, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  memory.writeUInt8(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.inRealtime);
  memory.writeDoubleLE(1200, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.lapDistance);
  for (const [offset, id, name, place] of [
    [playerOffset, 42, "Controlled player", 1],
    [opponentOffset, 7, "Controlled opponent", 2],
  ] as const) {
    memory.writeInt32LE(id, offset + LMU_SCORING_VEHICLE.id);
    memory.writeUInt8(id === 42 ? 1 : 0, offset + LMU_SCORING_VEHICLE.isPlayer);
    memory.writeUInt8(place, offset + LMU_SCORING_VEHICLE.place);
    memory.writeUInt8(2, offset + LMU_SCORING_VEHICLE.countLapFlag);
    text(offset + LMU_SCORING_VEHICLE.driverName, 32, name);
  }
  const encoder = new SparseCaptureEncoder("lmu");
  const tracker = new LmuOpponentIdentityTracker();
  const parts = [encodeMetaFrame(), encodeSparseCaptureFormatFrame()];
  let offset = parts.reduce((total, part) => total + part.length, 0);
  const rate = 20;
  const updateVehicle = (vehicleOffset: number, index: number, seconds: number, radialOffset: number) => {
    const samples = seconds * rate;
    const completed = Math.floor(index / samples);
    const progress = (index % samples) / samples;
    const angle = progress * Math.PI * 2;
    const radius = 1200 / (Math.PI * 2) + radialOffset;
    const position = [radius * Math.cos(angle), 0, radius * Math.sin(angle)];
    const orientation = [-Math.cos(angle), 0, Math.sin(angle), 0, 1, 0, -Math.sin(angle), 0, -Math.cos(angle)];
    const speed = radius * Math.PI * 2 / seconds;
    memory.writeInt16LE(completed, vehicleOffset + LMU_SCORING_VEHICLE.totalLaps);
    memory.writeUInt8((Math.floor(progress * 3) + 1) % 3, vehicleOffset + LMU_SCORING_VEHICLE.sector);
    memory.writeDoubleLE(progress * 1200, vehicleOffset + LMU_SCORING_VEHICLE.lapDistance);
    memory.writeDoubleLE(100 + completed * seconds, vehicleOffset + LMU_SCORING_VEHICLE.lapStartElapsedTime);
    memory.writeDoubleLE(completed ? seconds : -1, vehicleOffset + LMU_SCORING_VEHICLE.lastLapTime);
    memory.writeDoubleLE(completed ? seconds / 3 : -1, vehicleOffset + LMU_SCORING_VEHICLE.lastSector1);
    memory.writeDoubleLE(completed ? seconds * 2 / 3 : -1, vehicleOffset + LMU_SCORING_VEHICLE.lastSector2);
    for (let axis = 0; axis < 3; axis++) {
      memory.writeDoubleLE(position[axis]!, vehicleOffset + LMU_SCORING_VEHICLE.position + axis * 8);
      memory.writeDoubleLE(axis === 2 ? -speed : 0, vehicleOffset + LMU_SCORING_VEHICLE.localVelocity + axis * 8);
    }
    for (let axis = 0; axis < 9; axis++) memory.writeDoubleLE(orientation[axis]!, vehicleOffset + LMU_SCORING_VEHICLE.orientation + axis * 8);
    return { completed, position, orientation, speed };
  };
  for (let index = 0; index <= 39 * rate; index++) {
    const elapsed = 100 + index / rate;
    const timestamp = 1_790_000_000_000 + index * 50;
    const player = updateVehicle(playerOffset, index, 12, 0);
    updateVehicle(opponentOffset, index, 18, 3);
    memory.writeDoubleLE(elapsed, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
    memory.writeDoubleLE(elapsed, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
    memory.writeDoubleLE(100 + player.completed * 12, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.lapStartElapsedTime);
    memory.writeInt32LE(player.completed + 1, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.lapNumber);
    for (let axis = 0; axis < 3; axis++) {
      memory.writeDoubleLE(player.position[axis]!, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.position + axis * 8);
      memory.writeDoubleLE(axis === 2 ? -player.speed : 0, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.localVelocity + axis * 8);
    }
    for (let axis = 0; axis < 9; axis++) memory.writeDoubleLE(player.orientation[axis]!, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.orientation + axis * 8);
    const sessionKey = identity === "default" ? "controlled-opponent-fixture" : `controlled-opponent-fixture:${identity}`;
    const competitors = tracker.snapshot(memory, sessionKey, BigInt(index + 1), 42);
    assert.equal(competitors?.length, 2);
    const frame = encodeLMUSourceFrame(memory, timestamp, { context: {
      schemaVersion: 1, status: "active", playerVehicleId: 42, supplemental: [], competitors: competitors!,
      key: { sessionKey, captureSequence: String(index + 1), frameTime: { domain: "wall-clock", milliseconds: timestamp } },
    } });
    assert(frame);
    const encoded = encoder.encode(frame, offset);
    const prefix = encodeFrameLength(encoded.length, timestamp);
    parts.push(prefix, encoded);
    offset += prefix.length + encoded.length;
  }
  return gzipSync(Buffer.concat(parts));
}
