import { tryGetGame } from "@shared/games/registry";
import type { GameId } from "../../../../shared/games/ids";
import { resolveAnalysisTelemetry } from "../../../../shared/racing/analysis/telemetry-capabilities";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import { useTirePressureOptimal } from "../../hooks/queries";
import type { useUnits } from "../../hooks/useUnits";
import type { DisplayPacket } from "../../lib/convert-packet";
import { brakeTempColor, tireHealthColor, tirePressureColor, tireTempColor, wearRateColor } from "../../lib/vehicle-dynamics";
import { m } from "../../paraglide/messages";
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
  gameId: GameId;
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
  const wearRates = (["FL", "FR", "RL", "RR"] as const).map((w) => (wearRate ? wearRate[w] * 100 : null));
  const adapter = tryGetGame(gameId);
  const analysis = resolveAnalysisTelemetry(adapter);
  const hThresh = adapter?.tireHealthThresholds ?? { green: 0.7, yellow: 0.4 };
  const pressureOptimal = useTirePressureOptimal(gameId, currentPacket.CarOrdinal);

  const brakeFL = currentPacket.BrakeTempFrontLeft ?? currentPacket.f1?.brakeTempFL ?? 0;
  const brakeFR = currentPacket.BrakeTempFrontRight ?? currentPacket.f1?.brakeTempFR ?? 0;
  const brakeRL = currentPacket.BrakeTempRearLeft ?? currentPacket.f1?.brakeTempRL ?? 0;
  const brakeRR = currentPacket.BrakeTempRearRight ?? currentPacket.f1?.brakeTempRR ?? 0;
  const hasBrakes = brakeFL > 0 || brakeFR > 0;

  const pressFL = currentPacket.TirePressureFrontLeft ?? currentPacket.f1?.tyrePressureFL ?? 0;
  const pressFR = currentPacket.TirePressureFrontRight ?? currentPacket.f1?.tyrePressureFR ?? 0;
  const pressRL = currentPacket.TirePressureRearLeft ?? currentPacket.f1?.tyrePressureRL ?? 0;
  const pressRR = currentPacket.TirePressureRearRight ?? currentPacket.f1?.tyrePressureRR ?? 0;
  const hasPressure = pressFL > 0 || pressFR > 0;

  // Camber row intentionally omitted: ACC declares camberRAD[4] in its shared
  // memory struct but Kunos has never populated it — the field ships as 0 on
  // every release, in pit/track/replay. Re-enable once ACC (or AC Evo) starts
  // writing real values.

  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;
  const unavailable = <span className="text-app-text-dim">—</span>;
  const pitTemperature = analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot";
  const pitHealth = analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot";
  const coldPressure = analysis.tirePressure.source !== "unavailable" && analysis.tirePressure.display === "cold-pressure";
  const pressureColor = (pressure: number) => (coldPressure ? "var(--app-text)" : tirePressureColor(pressure, pressureOptimal));

  const rows = [
    {
      label: m.analyse_wheels_rotation_s(),
      fl: analysis.wheelRotation.source === "unavailable" ? unavailable : speeds[0].toFixed(1),
      fr: analysis.wheelRotation.source === "unavailable" ? unavailable : speeds[1].toFixed(1),
      rl: analysis.wheelRotation.source === "unavailable" ? unavailable : speeds[2].toFixed(1),
      rr: analysis.wheelRotation.source === "unavailable" ? unavailable : speeds[3].toFixed(1),
    },
    {
      label: pitTemperature ? m.analyse_wheels_pit_temp() : m.analyse_wheels_temp(),
      fl: C(`${fl.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(currentPacket.TireTempFL), units.thresholds)),
      fr: C(`${fr.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(currentPacket.TireTempFR), units.thresholds)),
      rl: C(`${rl.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(currentPacket.TireTempRL), units.thresholds)),
      rr: C(`${rr.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(currentPacket.TireTempRR), units.thresholds)),
    },
    {
      label: pitHealth ? m.analyse_wheels_pit_health() : m.analyse_wheels_health(),
      fl: C(`${((1 - healths[0]) * 100).toFixed(1)}%`, tireHealthColor(healths[0], hThresh)),
      fr: C(`${((1 - healths[1]) * 100).toFixed(1)}%`, tireHealthColor(healths[1], hThresh)),
      rl: C(`${((1 - healths[2]) * 100).toFixed(1)}%`, tireHealthColor(healths[2], hThresh)),
      rr: C(`${((1 - healths[3]) * 100).toFixed(1)}%`, tireHealthColor(healths[3], hThresh)),
    },
    ...(analysis.tireWearRate.source !== "unavailable"
      ? [
          {
            label: m.analyse_wheels_wear_s(),
            fl: C(wearRates[0] != null ? `${wearRates[0].toFixed(3)}%` : "—", wearRateColor(wearRates[0])),
            fr: C(wearRates[1] != null ? `${wearRates[1].toFixed(3)}%` : "—", wearRateColor(wearRates[1])),
            rl: C(wearRates[2] != null ? `${wearRates[2].toFixed(3)}%` : "—", wearRateColor(wearRates[2])),
            rr: C(wearRates[3] != null ? `${wearRates[3].toFixed(3)}%` : "—", wearRateColor(wearRates[3])),
          },
        ]
      : []),
    ...(hasBrakes
      ? [
          {
            label: m.analyse_wheels_brake(),
            fl: C(`${brakeFL.toFixed(0)}°C`, brakeTempColor(brakeFL, false)),
            fr: C(`${brakeFR.toFixed(0)}°C`, brakeTempColor(brakeFR, false)),
            rl: C(`${brakeRL.toFixed(0)}°C`, brakeTempColor(brakeRL, true)),
            rr: C(`${brakeRR.toFixed(0)}°C`, brakeTempColor(brakeRR, true)),
          },
        ]
      : []),
    ...(hasPressure && analysis.tirePressure.source !== "unavailable"
      ? [
          {
            label: coldPressure ? m.analyse_wheels_cold_pressure() : m.analyse_wheels_pressure(),
            fl: C(`${pressFL.toFixed(1)} psi`, pressureColor(pressFL)),
            fr: C(`${pressFR.toFixed(1)} psi`, pressureColor(pressFR)),
            rl: C(`${pressRL.toFixed(1)} psi`, pressureColor(pressRL)),
            rr: C(`${pressRR.toFixed(1)} psi`, pressureColor(pressRR)),
          },
        ]
      : []),
  ];

  return (
    <div className="text-app-compact font-mono">
      <WheelTable title={m.analyse_wheels_wheels()} borderTop rows={rows} />
    </div>
  );
}
