import { m } from "../../paraglide/messages";
import { semanticNumber, type SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";

const ERS_MODES = [m.f1live_ers_none(), m.f1live_ers_low(), m.f1ers_mode_medium(), m.f1live_ers_high(), m.f1live_ers_overtake()];
const available = (frame: SemanticAnalysisFrame, id: string) => (!frame.states[id] || frame.states[id] === "ok") && (!frame.freshness[id] || frame.freshness[id] === "fresh");
const enumIndex = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => {
  if (!available(frame, id)) return null;
  const value = frame.values[id];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return null;
};

export function AnalyseF1ErsPanel({ frame }: { frame: SemanticAnalysisFrame }) {
  const store = available(frame, "fuel.ers-store-energy") ? semanticNumber(frame, "fuel.ers-store-energy") : null;
  const deployed = available(frame, "fuel.ers-deployed") ? semanticNumber(frame, "fuel.ers-deployed") : null;
  const harvested = available(frame, "fuel.ers-harvested") ? semanticNumber(frame, "fuel.ers-harvested") : null;
  const mode = enumIndex(frame, "fuel.ers-deploy-mode");
  const format2026 = enumIndex(frame, "identity.telemetry-wire-format") === 2026;
  const regulations = available(frame, "identity.f1-regulations-2026") ? frame.values["identity.f1-regulations-2026"] : undefined;
  const showDrs = !format2026 || regulations === false || regulations === 0;
  const drsValue = available(frame, "aero.drs-active") ? frame.values["aero.drs-active"] : undefined;
  const drs = drsValue === true || drsValue === 1;
  const energy = (value: number | null) => value === null ? "—" : format2026 ? `${(value / 1000).toFixed(0)} kJ` : `${((value / 4_000_000) * 100).toFixed(1)}%`;
  const ersPct = ((store ?? 0) / 4_000_000) * 100;
  const ersBarColor = ersPct < 20 ? "bg-(--severity-critical)" : ersPct < 50 ? "bg-(--severity-caution)" : "bg-(--severity-nominal)";
  return (
    <>
      <h3 className="text-app-caption text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">{showDrs ? m.analyse_drs_ers() : m.f1live_ers_label()}</h3>
      <div className="text-app-compact font-mono space-y-1.5 mb-3">
        {showDrs && <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_drs()}</span>
          <span className={`font-bold ${drs ? "text-(--telemetry-drs)" : "text-app-text-dim"}`}>{drsValue == null ? "—" : drs ? m.f1live_drs_open() : m.f1live_drs_off()}</span>
        </div>}
        <div>
          <div className="flex justify-between mb-0.5">
            <span className="text-app-text-muted">{m.analyse_ers_store()}</span>
            <span className="tabular-nums text-(--telemetry-ers-store)">{energy(store)}</span>
          </div>
          {!format2026 && store !== null && <div className="h-1.5 bg-app-surface-alt rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${ersBarColor}`} style={{ width: `${Math.max(0, Math.min(100, ersPct))}%` }} />
          </div>}
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_deployed()}</span>
          <span className="tabular-nums text-(--telemetry-ers-deployed)">{energy(deployed)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_harvested()}</span>
          <span className="tabular-nums text-(--severity-nominal)">{energy(harvested)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_mode()}</span>
            <span className="tabular-nums text-app-text">{mode === null ? "—" : format2026 && mode === 3 ? m.live_boost() : ERS_MODES[mode] ?? m.f1live_unknown()}</span>
        </div>
      </div>
    </>
  );
}
