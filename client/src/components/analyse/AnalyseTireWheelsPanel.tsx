import type { TelemetryPacket, GameId } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import { tryGetGame } from "@shared/games/registry";
import { tireTempColor, tireHealthColor, wearRateColor, brakeTempColor, COLORS } from "../../lib/vehicle-dynamics";
import type { useUnits } from "../../hooks/useUnits";
import { WheelTable } from "./WheelTable";

interface WearRate {
  FL: number;
  FR: number;
  RL: number;
  RR: number;
}

interface Props {
  currentPacket: TelemetryPacket;
  currentDisplayPacket: DisplayPacket | null;
  gameId: GameId | undefined;
  units: ReturnType<typeof useUnits>;
  wearRate: WearRate | null;
}

export function AnalyseTireWheelsPanel({ currentPacket, currentDisplayPacket, gameId, units, wearRate }: Props) {
  const fl = currentDisplayPacket?.DisplayTireTempFL ?? currentPacket.TireTempFL;
  const fr = currentDisplayPacket?.DisplayTireTempFR ?? currentPacket.TireTempFR;
  const rl = currentDisplayPacket?.DisplayTireTempRL ?? currentPacket.TireTempRL;
  const rr = currentDisplayPacket?.DisplayTireTempRR ?? currentPacket.TireTempRR;
  const healths = [currentPacket.TireWearFL, currentPacket.TireWearFR, currentPacket.TireWearRL, currentPacket.TireWearRR];
  const speeds = [currentPacket.WheelRotationSpeedFL, currentPacket.WheelRotationSpeedFR, currentPacket.WheelRotationSpeedRL, currentPacket.WheelRotationSpeedRR];
  const wearRates = (["FL", "FR", "RL", "RR"] as const).map(w => wearRate ? wearRate[w] * 100 : null);
  const hThresh = tryGetGame(gameId ?? "fm-2023")?.tireHealthThresholds ?? { green: 0.70, yellow: 0.40 };

  const brakeFL = currentPacket.BrakeTempFrontLeft ?? currentPacket.f1?.brakeTempFL ?? 0;
  const brakeFR = currentPacket.BrakeTempFrontRight ?? currentPacket.f1?.brakeTempFR ?? 0;
  const brakeRL = currentPacket.BrakeTempRearLeft ?? currentPacket.f1?.brakeTempRL ?? 0;
  const brakeRR = currentPacket.BrakeTempRearRight ?? currentPacket.f1?.brakeTempRR ?? 0;
  const hasBrakes = brakeFL > 0 || brakeFR > 0;

  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;

  const rows = [
    { label: "Rotation /s", fl: speeds[0].toFixed(1), fr: speeds[1].toFixed(1), rl: speeds[2].toFixed(1), rr: speeds[3].toFixed(1) },
    { label: "Temp", fl: C(`${fl.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(currentPacket.TireTempFL), units.thresholds)), fr: C(`${fr.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(currentPacket.TireTempFR), units.thresholds)), rl: C(`${rl.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(currentPacket.TireTempRL), units.thresholds)), rr: C(`${rr.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(currentPacket.TireTempRR), units.thresholds)) },
    { label: "Health", fl: C(`${((1 - healths[0]) * 100).toFixed(1)}%`, tireHealthColor(healths[0], hThresh)), fr: C(`${((1 - healths[1]) * 100).toFixed(1)}%`, tireHealthColor(healths[1], hThresh)), rl: C(`${((1 - healths[2]) * 100).toFixed(1)}%`, tireHealthColor(healths[2], hThresh)), rr: C(`${((1 - healths[3]) * 100).toFixed(1)}%`, tireHealthColor(healths[3], hThresh)) },
    { label: "Wear /s", fl: C(wearRates[0] != null ? wearRates[0].toFixed(3) + "%" : "—", wearRateColor(wearRates[0])), fr: C(wearRates[1] != null ? wearRates[1].toFixed(3) + "%" : "—", wearRateColor(wearRates[1])), rl: C(wearRates[2] != null ? wearRates[2].toFixed(3) + "%" : "—", wearRateColor(wearRates[2])), rr: C(wearRates[3] != null ? wearRates[3].toFixed(3) + "%" : "—", wearRateColor(wearRates[3])) },
    ...(hasBrakes ? [{ label: "Brake", fl: C(`${brakeFL.toFixed(0)}°C`, COLORS[brakeTempColor(brakeFL, false)]), fr: C(`${brakeFR.toFixed(0)}°C`, COLORS[brakeTempColor(brakeFR, false)]), rl: C(`${brakeRL.toFixed(0)}°C`, COLORS[brakeTempColor(brakeRL, true)]), rr: C(`${brakeRR.toFixed(0)}°C`, COLORS[brakeTempColor(brakeRR, true)]) }] : []),
  ];

  return (
    <div className="text-[11px] font-mono">
      <WheelTable title="Wheels" borderTop rows={rows} />
    </div>
  );
}
