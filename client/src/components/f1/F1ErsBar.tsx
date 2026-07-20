import type { F1ExtendedData } from "@shared/types";
import { m } from "@/paraglide/messages";

const ERS_MAX_ENERGY = 4_000_000; // 4 MJ max ERS store

const DEPLOY_MODES: Record<number, { labelKey: string; color: string }> = {
  0: { labelKey: "f1ers_mode_none", color: "text-zinc-500" },
  1: { labelKey: "f1ers_mode_medium", color: "text-blue-400" },
  2: { labelKey: "f1ers_mode_hotlap", color: "text-purple-400" },
  3: { labelKey: "f1ers_mode_overtake", color: "text-red-400" },
};

const getModeLabel = (labelKey: string): string => {
  switch (labelKey) {
    case "f1ers_mode_none":
      return m.f1ers_mode_none();
    case "f1ers_mode_medium":
      return m.f1ers_mode_medium();
    case "f1ers_mode_hotlap":
      return m.f1ers_mode_hotlap();
    case "f1ers_mode_overtake":
      return m.f1ers_mode_overtake();
    default:
      return "";
  }
};

export function F1ErsBar({ f1 }: { f1: F1ExtendedData }) {
  const pct = Math.min(100, (f1.ersStoreEnergy / ERS_MAX_ENERGY) * 100);
  const mode = DEPLOY_MODES[f1.ersDeployMode] ?? DEPLOY_MODES[0];
  const modeLabel = getModeLabel(mode.labelKey);

  const deployedPct = Math.min(100, (f1.ersDeployedThisLap / ERS_MAX_ENERGY) * 100);
  const harvestedPct = Math.min(100, (f1.ersHarvestedThisLap / ERS_MAX_ENERGY) * 100);

  // Color based on charge level
  let barColor = "bg-green-500";
  if (pct < 20) barColor = "bg-red-500";
  else if (pct < 50) barColor = "bg-yellow-500";

  return (
    <div className="rounded-lg bg-zinc-900 p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-zinc-400 font-medium">{m.f1ers_label()}</span>
        <span className={`text-xs font-bold ${mode.color}`}>{modeLabel}</span>
      </div>

      {/* Battery bar */}
      <div className="h-3 bg-zinc-800 rounded-full overflow-hidden mb-2">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>

      {/* Deploy / Harvest stats */}
      <div className="flex justify-between text-[10px] text-zinc-500">
        <span>
          {m.f1ers_deploy()}: {deployedPct.toFixed(0)}%
        </span>
        <span>{pct.toFixed(0)}%</span>
        <span>
          {m.f1ers_harvest()}: {harvestedPct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
