import { m } from "../../paraglide/messages";
import { semanticNumber, type SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";
import { getF1ErsDeployModeName } from "@raceiq/shared/telemetry/f1-2025";

const available = (frame: SemanticAnalysisFrame, id: string) => (!frame.states[id] || frame.states[id] === "ok") && (!frame.freshness[id] || frame.freshness[id] === "fresh");
const enumIndex = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => {
  if (!available(frame, id)) return null;
  const value = frame.values[id];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return null;
};
const semanticBoolean = (frame: SemanticAnalysisFrame, id: string): boolean | undefined => {
  if (!available(frame, id)) return undefined;
  const value = frame.values[id];
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  return undefined;
};
const availabilityLabel = (value: boolean | undefined) => value === undefined ? "—" : value ? m.analyse_available() : m.analyse_unavailable_short();
const enabledLabel = (value: boolean | undefined) => value === undefined ? "—" : value ? m.common_enabled() : m.common_disabled();
const distanceLabel = (value: number | undefined) => value === undefined || value <= 0 ? "—" : `${value} m`;
function ersModeLabel(mode: number | null, wireFormat: number | undefined): string {
  const name = getF1ErsDeployModeName(mode ?? undefined, wireFormat);
  if (name === undefined && mode === 4 && (wireFormat === undefined || wireFormat === 2025)) return m.f1live_ers_overtake();
  switch (name) {
    case "none": return m.f1ers_mode_none();
    case "medium": return m.f1ers_mode_medium();
    case "hotlap": return m.f1ers_mode_hotlap();
    case "overtake": return m.f1live_ers_overtake();
    case "boost": return m.live_boost();
    default: return m.f1live_unknown();
  }
}

export function AnalyseF1ErsPanel({ frame }: { frame: SemanticAnalysisFrame }) {
  const store = available(frame, "fuel.ers-store-energy") ? semanticNumber(frame, "fuel.ers-store-energy") : null;
  const deployed = available(frame, "fuel.ers-deployed") ? semanticNumber(frame, "fuel.ers-deployed") : null;
  const harvested = available(frame, "fuel.ers-harvested") ? semanticNumber(frame, "fuel.ers-harvested") : null;
  const mode = enumIndex(frame, "fuel.ers-deploy-mode");
  const wireFormat = enumIndex(frame, "identity.telemetry-wire-format") ?? undefined;
  const format2026 = wireFormat === 2026;
  const regulations = available(frame, "identity.f1-regulations-2026") ? frame.values["identity.f1-regulations-2026"] : undefined;
  const regulations2026 = regulations === true || regulations === 1;
  const showDrs = !format2026 || regulations === false || regulations === 0;
  const drsValue = available(frame, "aero.drs-active") ? frame.values["aero.drs-active"] : undefined;
  const drs = drsValue === true || drsValue === 1;
  const activeAeroMode = enumIndex(frame, "aero.active-aero-mode");
  const activeAeroAvailable = semanticBoolean(frame, "aero.active-aero-available");
  const activeAeroDistance = available(frame, "aero.active-aero-activation-distance") ? semanticNumber(frame, "aero.active-aero-activation-distance") ?? undefined : undefined;
  const overtakeAvailable = semanticBoolean(frame, "electronics.overtake-available");
  const overtakeActive = semanticBoolean(frame, "electronics.overtake-active");
  const overtakeDistance = available(frame, "electronics.overtake-activation-distance") ? semanticNumber(frame, "electronics.overtake-activation-distance") ?? undefined : undefined;
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
        {format2026 && regulations2026 && <>
          <div className="border-t border-app-border pt-2 text-app-caption font-semibold text-app-text-muted">{m.f1live_active_aero()}</div>
          <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_mode()}</span><span className="tabular-nums text-app-text">{activeAeroMode === 0 ? m.label_corner() : activeAeroMode === 1 ? m.analyse_straight() : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_available()}</span><span className="tabular-nums text-app-text">{availabilityLabel(activeAeroAvailable)}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">{m.recap_distance()}</span><span className="tabular-nums text-app-text">{distanceLabel(activeAeroDistance)}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">{m.f1live_ers_overtake()}</span><span className="tabular-nums text-app-text">{enabledLabel(overtakeActive)}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_available()}</span><span className="tabular-nums text-app-text">{availabilityLabel(overtakeAvailable)}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">{m.recap_distance()}</span><span className="tabular-nums text-app-text">{distanceLabel(overtakeDistance)}</span></div>
        </>}
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
            <span className="tabular-nums text-app-text">{mode === null ? "—" : ersModeLabel(mode, wireFormat)}</span>
        </div>
      </div>
    </>
  );
}
