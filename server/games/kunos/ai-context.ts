import type { TelemetryPacket } from "../../../shared/telemetry/types";

/**
 * Builds the AI context text shared by Kunos adapters.
 */
export function buildKunosAiContext(
  packets: TelemetryPacket[],
  includeWeather: boolean,
): string {
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
    if (includeWeather) {
      lines.push(`Weather — Rain: ${(accFirst.rainIntensity * 100).toFixed(0)}%, Grip: ${accFirst.trackGripStatus}`);
    }
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
}
