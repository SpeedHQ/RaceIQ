import type { TelemetryPacket } from "../telemetry/types";
import type { TelemetryModel } from "./types";

export const WATTS_PER_HORSEPOWER = 745.7;

export interface FuelAmount {
  amount: number;
  unit: "%" | "L";
}

export interface FuelDisplay extends FuelAmount {
  /** Tank fill from 0 to 1 when the packet carries a real capacity. */
  fillRatio?: number;
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function getFuelAmount(
  value: number,
  spec: TelemetryModel["fuel"],
): FuelAmount {
  if (spec.packetUnit === "fraction") {
    return { amount: value * 100, unit: "%" };
  }
  return { amount: value, unit: "L" };
}

export function getFuelDisplay(
  packet: Pick<TelemetryPacket, "Fuel" | "FuelCapacity">,
  spec: TelemetryModel["fuel"],
): FuelDisplay {
  const display = getFuelAmount(packet.Fuel, spec);
  if (spec.packetUnit === "fraction") {
    return { ...display, fillRatio: clampRatio(packet.Fuel) };
  }
  if (
    packet.FuelCapacity !== undefined &&
    Number.isFinite(packet.FuelCapacity) &&
    packet.FuelCapacity > 0
  ) {
    return {
      ...display,
      fillRatio: clampRatio(packet.Fuel / packet.FuelCapacity),
    };
  }
  return display;
}

export function getFuelDisplaySemantic(
  fuel: number,
  capacity: number | undefined,
  spec: TelemetryModel["fuel"],
): FuelDisplay {
  return getFuelDisplay({ Fuel: fuel, FuelCapacity: capacity }, spec);
}

export function getTireTemperatureSourceUnit(
  spec: TelemetryModel["tireTemperature"],
): "C" | "F" {
  return spec.packetUnit === "fahrenheit" ? "F" : "C";
}
