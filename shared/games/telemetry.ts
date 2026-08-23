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
  {
    remainingVolumeL,
    remainingFraction,
    capacityL,
  }: {
    remainingVolumeL?: number;
    remainingFraction?: number;
    capacityL?: number;
  },
): FuelDisplay {
  const hasVolume =
    remainingVolumeL !== undefined && Number.isFinite(remainingVolumeL);
  const hasFraction =
    remainingFraction !== undefined && Number.isFinite(remainingFraction);
  const hasCapacity =
    capacityL !== undefined && Number.isFinite(capacityL) && capacityL > 0;

  const fillRatio = hasFraction
    ? clampRatio(remainingFraction)
    : hasVolume && hasCapacity
      ? clampRatio(remainingVolumeL / capacityL)
      : undefined;

  if (hasVolume) {
    return {
      amount: remainingVolumeL,
      unit: "L",
      ...(fillRatio === undefined ? {} : { fillRatio }),
    };
  }

  return {
    amount: hasFraction ? remainingFraction * 100 : Number.NaN,
    unit: "%",
    ...(fillRatio === undefined ? {} : { fillRatio }),
  };
}

export function getTireTemperatureSourceUnit(
  spec: TelemetryModel["tireTemperature"],
): "C" | "F" {
  return spec.packetUnit === "fahrenheit" ? "F" : "C";
}
