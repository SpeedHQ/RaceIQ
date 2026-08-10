import type { SemanticAnalysisFrame } from "./AnalyseSegmentList";
import type { LapCapabilities } from "./analyse-capabilities";
import { m } from "../../paraglide/messages";

const ERS_MODES = ["None", "Low", "Medium", "High", "Overtake"];
const number = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

interface Props {
  frame: SemanticAnalysisFrame;
  capabilities: LapCapabilities;
}

export function AnalyseF1ErsPanel({ frame, capabilities }: Props) {
  const store = number(frame, "fuel.ers-store-energy");
  const deployed = number(frame, "fuel.ers-deployed");
  const harvested = number(frame, "fuel.ers-harvested");
  const mode = number(frame, "fuel.ers-deploy-mode");
  const drsValue = frame.values["aero.drs-active"];
  const drs = drsValue === true || drsValue === 1;
  const pct = (value: number) => `${((value / 4_000_000) * 100).toFixed(1)}%`;
  const ersPct = store == null ? null : (store / 4_000_000) * 100;
  const ersBarColor = ersPct == null ? "bg-app-surface-alt" : ersPct < 20 ? "bg-(--severity-critical)" : ersPct < 50 ? "bg-(--severity-caution)" : "bg-(--severity-nominal)";
  if (!capabilities.hasDrs && !capabilities.hasErs) return null;
  return <>
    {(capabilities.hasDrs || capabilities.hasErs) && <h3 className="text-app-caption text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">{capabilities.hasDrs && capabilities.hasErs ? m.analyse_drs_ers() : capabilities.hasDrs ? m.analyse_drs() : "ERS"}</h3>}
    <div className="text-app-compact font-mono space-y-1.5 mb-3">
      {capabilities.hasDrs && <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_drs()}</span><span className={`font-bold ${drs ? "text-(--telemetry-drs)" : "text-app-text-dim"}`}>{drs ? "OPEN" : "OFF"}</span></div>}
      {capabilities.hasErs && store != null && <div><div className="flex justify-between mb-0.5"><span className="text-app-text-muted">{m.analyse_ers_store()}</span><span className="tabular-nums text-(--telemetry-ers-store)">{pct(store)}</span></div><div className="h-1.5 bg-app-surface-alt rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all ${ersBarColor}`} style={{ width: `${Math.max(0, Math.min(100, ersPct ?? 0))}%` }} /></div></div>}
      {capabilities.hasErs && deployed != null && <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_deployed()}</span><span className="tabular-nums text-(--telemetry-ers-deployed)">{pct(deployed)}</span></div>}
      {capabilities.hasErs && harvested != null && <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_harvested()}</span><span className="tabular-nums text-(--severity-nominal)">{pct(harvested)}</span></div>}
      {capabilities.hasErs && mode != null && <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_mode()}</span><span className="tabular-nums text-app-text">{ERS_MODES[mode] ?? "Unknown"}</span></div>}
    </div>
  </>;
}
