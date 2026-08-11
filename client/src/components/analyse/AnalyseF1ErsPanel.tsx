import type { SemanticAnalysisFrame } from "./AnalyseSegmentList";
import { m } from "../../paraglide/messages";

const ERS_MODES = ["None", "Low", "Medium", "High", "Overtake"];
const number = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const enumIndex = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => {
  const value = frame.values[id];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return null;
};

export function AnalyseF1ErsPanel({ frame }: { frame: SemanticAnalysisFrame }) {
  const store = number(frame, "fuel.ers-store-energy") ?? 0;
  const deployed = number(frame, "fuel.ers-deployed") ?? 0;
  const harvested = number(frame, "fuel.ers-harvested") ?? 0;
  const mode = enumIndex(frame, "fuel.ers-deploy-mode") ?? 0;
  const drsValue = frame.values["aero.drs-active"];
  const drs = drsValue === true || drsValue === 1;
  const pct = (value: number) => `${((value / 4_000_000) * 100).toFixed(1)}%`;
  const ersPct = (store / 4_000_000) * 100;
  const ersBarColor = ersPct < 20 ? "bg-(--severity-critical)" : ersPct < 50 ? "bg-(--severity-caution)" : "bg-(--severity-nominal)";
  return <>
    <h3 className="text-app-caption text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">{m.analyse_drs_ers()}</h3>
    <div className="text-app-compact font-mono space-y-1.5 mb-3">
      <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_drs()}</span><span className={`font-bold ${drs ? "text-(--telemetry-drs)" : "text-app-text-dim"}`}>{drs ? "OPEN" : "OFF"}</span></div>
      <div><div className="flex justify-between mb-0.5"><span className="text-app-text-muted">{m.analyse_ers_store()}</span><span className="tabular-nums text-(--telemetry-ers-store)">{pct(store)}</span></div><div className="h-1.5 bg-app-surface-alt rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all ${ersBarColor}`} style={{ width: `${Math.max(0, Math.min(100, ersPct))}%` }} /></div></div>
      <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_deployed()}</span><span className="tabular-nums text-(--telemetry-ers-deployed)">{pct(deployed)}</span></div>
      <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_harvested()}</span><span className="tabular-nums text-(--severity-nominal)">{pct(harvested)}</span></div>
      <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_mode()}</span><span className="tabular-nums text-app-text">{ERS_MODES[mode] ?? "Unknown"}</span></div>
    </div>
  </>;
}
