import type { F1ExtendedData } from "@shared/types";
import { m } from "@/paraglide/messages";

const ERS_MAX_ENERGY = 4_000_000; // 4 MJ max ERS store

const DEPLOY_MODES: Record<number, { labelKey: string; color: string }> = {
  0: { labelKey: "f1ers_mode_none", color: "text-app-text-dim" },
  1: { labelKey: "f1ers_mode_medium", color: "text-(--telemetry-ers-mode-medium)" },
  2: { labelKey: "f1ers_mode_hotlap", color: "text-(--telemetry-ers-mode-hotlap)" },
  3: { labelKey: "f1ers_mode_overtake", color: "text-(--telemetry-ers-mode-overtake)" },
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
  let barColor = "bg-(--severity-nominal)";
  if (pct < 20) barColor = "bg-(--severity-critical)";
  else if (pct < 50) barColor = "bg-(--severity-caution)";

  return (
    <div className="rounded-lg bg-app-surface p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-app-text-muted font-medium">{m.f1ers_label()}</span>
        <span className={`text-xs font-bold ${mode.color}`}>{modeLabel}</span>
      </div>

      {/* Battery bar */}
      <div className="h-3 bg-app-surface-alt rounded-full overflow-hidden mb-2">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>

      {/* Deploy / Harvest stats */}
      <div className="flex justify-between text-app-caption text-app-text-dim">
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
