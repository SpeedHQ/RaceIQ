import type { TelemetryPacket } from "../../telemetry/types";

export type DamageVector = Readonly<Record<string, number>>;

export function damageVectorTotal(vector: DamageVector | null): number {
  if (vector == null) return 0;
  return Object.values(vector)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
}


/** Packet compatibility boundary used only by quality measurement. */
export function telemetryDamageVector(packet: TelemetryPacket): DamageVector {
  const f1 = packet.f1;
  const entries: Array<[string, number]> = [
    ["front-left-wing", f1?.frontLeftWingDamage ?? 0],
    ["front-right-wing", f1?.frontRightWingDamage ?? 0],
    ["rear-wing", f1?.rearWingDamage ?? 0],
    ["floor", f1?.floorDamage ?? 0],
    ["diffuser", f1?.diffuserDamage ?? 0],
    ["sidepod", f1?.sidepodDamage ?? 0],
  ];
  for (const [component, value] of Object.entries(packet.acc?.carDamage ?? {})) {
    entries.push([`kunos-${component}`, value * 100]);
  }
  return Object.fromEntries(entries);
}
