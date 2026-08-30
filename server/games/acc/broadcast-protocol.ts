import type {
  AccBroadcastCar,
  AccBroadcastEntry,
  AccBroadcastLap,
  AccBroadcastMessage,
} from "../../../shared/telemetry/acc-broadcast";

export const ACC_BROADCAST_PROTOCOL_VERSION = 4;

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining(): number { return this.bytes.length - this.offset; }
  u8(): number { this.need(1); return this.bytes[this.offset++]!; }
  u16(): number { this.need(2); const v = this.bytes[this.offset]! | (this.bytes[this.offset + 1]! << 8); this.offset += 2; return v; }
  i16(): number { const value = this.u16(); return value & 0x8000 ? value - 0x10000 : value; }
  u32(): number { this.need(4); const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(0, true); this.offset += 4; return v; }
  i32(): number { this.need(4); const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getInt32(0, true); this.offset += 4; return v; }
  f32(): number { this.need(4); const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getFloat32(0, true); this.offset += 4; return v; }
  string(): string { const length = this.u16(); this.need(length); const value = new TextDecoder().decode(this.bytes.slice(this.offset, this.offset + length)); this.offset += length; return value; }
  private need(count: number): void { if (this.remaining < count) throw new RangeError("truncated ACC broadcast message"); }
}

const lap = (reader: Reader): AccBroadcastLap => {
  const timeMs = reader.i32();
  const carIndex = reader.u16();
  const driverIndex = reader.u16();
  const splitCount = reader.u8();
  const splitsMs = Array.from({ length: splitCount }, () => reader.i32());
  const isInvalid = reader.u8() > 0;
  const isValidForBest = reader.u8() > 0;
  const isOutlap = reader.u8() > 0;
  const isInlap = reader.u8() > 0;
  return {
    timeMs: timeMs === 0x7fffffff ? null : timeMs,
    carIndex,
    driverIndex,
    splitsMs: splitsMs.map((value) => value === 0x7fffffff ? null : value),
    isInvalid,
    isValidForBest,
    isOutlap,
    isInlap,
  };
};

export function parseAccBroadcastMessage(payload: Uint8Array): AccBroadcastMessage | null {
  try {
    const reader = new Reader(payload);
    switch (reader.u8()) {
      case 1: {
        const connectionId = reader.i32();
        const success = reader.u8() > 0;
        const readOnly = reader.u8() === 0;
        return { type: "registration-result", connectionId, success, readOnly, error: reader.string() };
      }
      case 2: {
        return {
          type: "realtime-update",
          eventIndex: reader.u16(), sessionIndex: reader.u16(), sessionType: reader.u8(), phase: reader.u8(),
          sessionTimeMs: reader.f32(), sessionEndTimeMs: reader.f32(), focusedCarIndex: reader.i32(),
          activeCameraSet: reader.string(), activeCamera: reader.string(), currentHudPage: reader.string(),
          replayPlaying: reader.u8() > 0,
          bestSessionLap: lap(reader),
        };
      }
      case 3: {
        const carIndex = reader.u16();
        const driverIndex = reader.u16();
        const driverCount = reader.u8();
        const gear = reader.u8() - 2;
        const worldPosX = reader.f32();
        const worldPosY = reader.f32();
        const yaw = reader.f32();
        const location = reader.u8();
        const kmh = reader.u16();
        const position = reader.u16();
        const cupPosition = reader.u16();
        reader.u16(); // ACC track position is always zero.
        const splinePosition = reader.f32();
        const laps = reader.u16();
        const deltaMs = reader.i32();
        const bestLap = lap(reader);
        const lastLap = lap(reader);
        const currentLap = lap(reader);
        const result: AccBroadcastCar = {
          carIndex, driverIndex, driverCount, gear, worldPosX, worldPosY, yaw, location, kmh, position, cupPosition,
          splinePosition, laps, deltaMs, bestLapTimeMs: bestLap.timeMs, lastLapTimeMs: lastLap.timeMs,
          lastLapValid: lastLap.timeMs !== null && !lastLap.isInvalid && !lastLap.isOutlap && !lastLap.isInlap,
          currentLapTimeMs: currentLap.timeMs,
        };
        return { type: "realtime-car-update", ...result };
      }
      case 4: {
        const connectionId = reader.i32();
        const count = reader.u16();
        return { type: "entry-list", connectionId, carIndexes: Array.from({ length: count }, () => reader.u16()) };
      }
      case 6: {
        const carIndex = reader.u16();
        const carModelType = reader.u8();
        const teamName = reader.string();
        const raceNumber = reader.i32();
        const cupCategory = reader.u8();
        const currentDriverIndex = reader.u8();
        const nationality = reader.i16();
        const driverCount = reader.u8();
        const drivers = Array.from({ length: driverCount }, () => ({
          firstName: reader.string(), lastName: reader.string(), shortName: reader.string(), category: reader.u8(), nationality: reader.i16(),
        }));
        const entry: AccBroadcastEntry = { carIndex, carModelType, teamName, raceNumber, cupCategory, currentDriverIndex, nationality, drivers };
        return { type: "entry-list-car", ...entry };
      }
      case 5: {
        const connectionId = reader.i32();
        const trackName = reader.string();
        const trackId = reader.i32();
        const trackMeters = reader.i32();
        return { type: "track-data", connectionId, trackName, trackId, trackMeters };
      }
      case 7: {
        const eventType = reader.u8();
        const message = reader.string();
        const timeMs = reader.i32();
        const carId = reader.i32();
        return { type: "broadcasting-event", eventType, message, timeMs, carId };
      }
      default: return null;
    }
  } catch {
    return null;
  }
}

function writeString(bytes: number[], value: string): void {
  const encoded = new TextEncoder().encode(value);
  bytes.push(encoded.length & 0xff, (encoded.length >>> 8) & 0xff, ...encoded);
}

export function encodeAccBroadcastRegistration(
  displayName: string,
  connectionPassword: string,
  realtimeIntervalMs: number,
  commandPassword: string,
): Uint8Array {
  const bytes: number[] = [1, ACC_BROADCAST_PROTOCOL_VERSION];
  writeString(bytes, displayName);
  writeString(bytes, connectionPassword);
  const view = new DataView(new ArrayBuffer(4));
  view.setInt32(0, realtimeIntervalMs, true);
  bytes.push(...new Uint8Array(view.buffer));
  writeString(bytes, commandPassword);
  return Uint8Array.from(bytes);
}
export function encodeAccBroadcastEntryListRequest(connectionId: number): Uint8Array {
  const buffer = new ArrayBuffer(5);
  const bytes = new Uint8Array(buffer);
  bytes[0] = 10;
  new DataView(buffer).setInt32(1, connectionId, true);
  return bytes;
}
