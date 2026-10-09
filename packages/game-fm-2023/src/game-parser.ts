import type { TelemetryParser } from "@raceiq/shared/telemetry/parser";
import { parseForzaPacket } from "./parser";
import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";

export const forzaParser: TelemetryParser<null> = {
  canHandle(buf) { return buf.length >= 324 && buf.length <= 400; },
  tryParse(buf) { return parseForzaPacket(buf); },
  tryParseLapIndex(buf): LapIndexPacket | null {
    if (buf.length < 324) return null;
    const isRaceOn = buf.readInt32LE(0);
    if (isRaceOn === 0) return null;
    return {
      gameId: "fm-2023", IsRaceOn: isRaceOn, TimestampMS: buf.readUInt32LE(4),
      CarOrdinal: buf.readInt32LE(212), TrackOrdinal: buf.length >= 331 ? buf.readInt32LE(327) : 0,
      CarPerformanceIndex: buf.readInt32LE(220), CarClass: buf.readInt32LE(216),
      LapNumber: buf.readUInt16LE(300), CurrentLap: buf.readFloatLE(292), LastLap: buf.readFloatLE(288), BestLap: buf.readFloatLE(284),
      DistanceTraveled: buf.readFloatLE(280), PositionX: buf.readFloatLE(232), PositionZ: buf.readFloatLE(240), Yaw: buf.readFloatLE(56), Fuel: buf.readFloatLE(276),
      TireWearFL: buf.length >= 331 ? buf.readFloatLE(311) : -1, TireWearFR: buf.length >= 331 ? buf.readFloatLE(315) : -1,
      TireWearRL: buf.length >= 331 ? buf.readFloatLE(319) : -1, TireWearRR: buf.length >= 331 ? buf.readFloatLE(323) : -1,
      RacePosition: buf.readUInt8(302), WheelOnRumbleStripFL: buf.readInt32LE(116), WheelOnRumbleStripFR: buf.readInt32LE(120),
      WheelOnRumbleStripRL: buf.readInt32LE(124), WheelOnRumbleStripRR: buf.readInt32LE(128),
    };
  },
  primeParserState() {},
  createParserState() { return null; },
};
