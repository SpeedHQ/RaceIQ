import type { TelemetryPacket } from "@shared/types";

const WEATHER_NAMES = ["Clear", "Light Cloud", "Overcast", "Light Rain", "Heavy Rain", "Storm"];
const ERS_MODES = ["None", "Low", "Medium", "High", "Overtake"];

interface Props {
  currentPacket: TelemetryPacket;
}

export function AnalyseF1ErsPanel({ currentPacket }: Props) {
  const ersPct = (currentPacket.ErsStoreEnergy ?? 0) / 4_000_000 * 100;
  const ersBarColor = ersPct < 20 ? "bg-red-500" : ersPct < 50 ? "bg-yellow-500" : "bg-green-500";

  return (
    <>
      <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">
        DRS / ERS
      </h3>
      <div className="text-[11px] font-mono space-y-1.5 mb-3">
        <div className="flex justify-between">
          <span className="text-app-text-muted">DRS</span>
          <span className={`font-bold ${currentPacket.DrsActive ? "text-green-400" : "text-app-text-dim"}`}>
            {currentPacket.DrsActive ? "OPEN" : "OFF"}
          </span>
        </div>
        <div>
          <div className="flex justify-between mb-0.5">
            <span className="text-app-text-muted">ERS Store</span>
            <span className="tabular-nums text-blue-400">{ersPct.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-app-surface-alt rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${ersBarColor}`} style={{ width: `${ersPct}%` }} />
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">Deployed</span>
          <span className="tabular-nums text-amber-400">{((currentPacket.ErsDeployed ?? 0) / 4_000_000 * 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">Harvested</span>
          <span className="tabular-nums text-emerald-400">{((currentPacket.ErsHarvested ?? 0) / 4_000_000 * 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">Mode</span>
          <span className="tabular-nums text-app-text">{ERS_MODES[currentPacket.ErsDeployMode ?? 0] ?? "Unknown"}</span>
        </div>
      </div>

      <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">
        Conditions
      </h3>
      <div className="text-[11px] font-mono space-y-1.5 mb-3">
        <div className="flex justify-between">
          <span className="text-app-text-muted">Weather</span>
          <span className="text-app-text">{WEATHER_NAMES[currentPacket.WeatherType ?? 0] ?? "Unknown"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">Track</span>
          <span className="tabular-nums text-orange-400">{currentPacket.TrackTemp ?? 0}°C</span>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">Air</span>
          <span className="tabular-nums text-cyan-400">{currentPacket.AirTemp ?? 0}°C</span>
        </div>
        {(currentPacket.RainPercent ?? 0) > 0 && (
          <div className="flex justify-between">
            <span className="text-app-text-muted">Rain</span>
            <span className="tabular-nums text-blue-400">{currentPacket.RainPercent}%</span>
          </div>
        )}
      </div>
    </>
  );
}
