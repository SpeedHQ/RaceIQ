import type { TelemetryPacket } from "@shared/types";
import { m } from "../../paraglide/messages";

const ERS_MODES = ["None", "Low", "Medium", "High", "Overtake"];

interface Props {
  currentPacket: TelemetryPacket;
}

export function AnalyseF1ErsPanel({ currentPacket }: Props) {
  const ersPct = ((currentPacket.ErsStoreEnergy ?? 0) / 4_000_000) * 100;
  const ersBarColor = ersPct < 20 ? "bg-(--severity-critical)" : ersPct < 50 ? "bg-(--severity-caution)" : "bg-(--severity-nominal)";

  return (
    <>
      <h3 className="text-app-caption text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">{m.analyse_drs_ers()}</h3>
      <div className="text-app-compact font-mono space-y-1.5 mb-3">
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_drs()}</span>
          <span className={`font-bold ${currentPacket.DrsActive ? "text-(--telemetry-drs)" : "text-app-text-dim"}`}>{currentPacket.DrsActive ? "OPEN" : "OFF"}</span>
        </div>
        <div>
          <div className="flex justify-between mb-0.5">
            <span className="text-app-text-muted">{m.analyse_ers_store()}</span>
          <span className="tabular-nums text-(--telemetry-ers-store)">{ersPct.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-app-surface-alt rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${ersBarColor}`} style={{ width: `${ersPct}%` }} />
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_deployed()}</span>
          <span className="tabular-nums text-(--telemetry-ers-deployed)">{(((currentPacket.ErsDeployed ?? 0) / 4_000_000) * 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_harvested()}</span>
          <span className="tabular-nums text-(--severity-nominal)">{(((currentPacket.ErsHarvested ?? 0) / 4_000_000) * 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_mode()}</span>
          <span className="tabular-nums text-app-text">{ERS_MODES[currentPacket.ErsDeployMode ?? 0] ?? "Unknown"}</span>
        </div>
      </div>
    </>
  );
}
