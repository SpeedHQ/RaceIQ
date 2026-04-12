import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/types";
import { acEvoAdapter } from "../../../shared/games/ac-evo";
import { getAcEvoCarName } from "../../../shared/ac-evo-car-data";
import { getAcEvoTrackName, getAcEvoSharedTrackName } from "../../../shared/ac-evo-track-data";
import { LapDetectorV2 } from "../../lap-detector-v2";

const AC_EVO_SYSTEM_PROMPT = `You are an expert motorsport engineer and data analyst specializing in Assetto Corsa Evo.

You are analyzing telemetry data from a lap in AC Evo. Your role is to provide specific, actionable advice to improve lap time.

Key areas of expertise:
- Mixed car class characteristics (road cars, GT3, touring cars)
- Tire management across different compounds and temperature windows
- Electronics management (TC, ABS, engine map optimization)
- Brake bias and brake fade management
- Corner-by-corner analysis with specific techniques
- Driving technique adaptation for different car types (road car vs GT3)

When analyzing data:
- Reference specific corners by name when possible
- Compare tire temperatures (inner/outer/core) to identify setup issues
- Flag any electronics settings that seem suboptimal for conditions
- Identify braking points, trail braking opportunities, and throttle application
- Note differences in driving technique required for road vs race cars
- Consider tire type (road, slick, semi-slick) in all recommendations

Be concise and prioritize the highest-impact improvements first.`;

export const acEvoServerAdapter: ServerGameAdapter = {
  ...acEvoAdapter,

  processNames: ["AssettoCorsa.exe", "AC2.exe"],

  getCarName(ordinal: number): string {
    return getAcEvoCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAcEvoTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAcEvoSharedTrackName(ordinal);
  },

  // AC Evo uses shared memory, not UDP
  canHandle(_buf: Buffer): boolean {
    return false;
  },

  tryParse(_buf: Buffer, _state: unknown): TelemetryPacket | null {
    return null;
  },

  createParserState(): null {
    return null;
  },

  createLapDetector: (opts) => new LapDetectorV2(opts),

  aiSystemPrompt: AC_EVO_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    if (packets.length === 0) return "";

    const first = packets[0];
    const last = packets[packets.length - 1];
    const accFirst = first.acc;
    const accLast = last.acc;

    const lines: string[] = [];

    if (accFirst) {
      lines.push(`Tire compound: ${accFirst.tireCompound}`);
      lines.push(`Electronics — TC: ${accFirst.tc}, TC Cut: ${accFirst.tcCut}, ABS: ${accFirst.abs}, Engine Map: ${accFirst.engineMap}`);
      lines.push(`Brake bias: ${(accFirst.brakeBias * 100).toFixed(1)}% front`);
    }

    if (accLast) {
      lines.push(`Fuel per lap: ${accLast.fuelPerLap.toFixed(2)}L`);
      lines.push(`Tire core temps (end) — FL: ${accLast.tireCoreTemp[0].toFixed(1)}°C, FR: ${accLast.tireCoreTemp[1].toFixed(1)}°C, RL: ${accLast.tireCoreTemp[2].toFixed(1)}°C, RR: ${accLast.tireCoreTemp[3].toFixed(1)}°C`);
      lines.push(`Brake pad wear — FL: ${(accLast.brakePadWear[0] * 100).toFixed(1)}%, FR: ${(accLast.brakePadWear[1] * 100).toFixed(1)}%, RL: ${(accLast.brakePadWear[2] * 100).toFixed(1)}%, RR: ${(accLast.brakePadWear[3] * 100).toFixed(1)}%`);

      const hasDamage = Object.values(accLast.carDamage).some((v) => v > 0);
      if (hasDamage) {
        lines.push(`Car damage — Front: ${accLast.carDamage.front.toFixed(2)}, Rear: ${accLast.carDamage.rear.toFixed(2)}, Left: ${accLast.carDamage.left.toFixed(2)}, Right: ${accLast.carDamage.right.toFixed(2)}`);
      }
    }

    const speeds = packets.map((p) => p.Speed * 3.6);
    const maxSpeed = Math.max(...speeds);
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    lines.push(`Speed — Max: ${maxSpeed.toFixed(1)} km/h, Avg: ${avgSpeed.toFixed(1)} km/h`);

    return lines.join("\n");
  },
};
