import { operatingRangeColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";
import type { SemanticAnalysisFrame } from "./track-map/types";
import { WheelTable } from "./WheelTable";

interface Props { frame: SemanticAnalysisFrame; }
const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const wheel = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"], index: number) => {
  const value = frame.values[id];
  return Array.isArray(value) && typeof value[index] === "number" && Number.isFinite(value[index]) ? value[index] : null;
}
const unavailable = <span className="text-app-text-dim">—</span>;

export function AnalyseSuspensionPanel({ frame }: Props) {
  const normalized = WHEELS.map((_, i) => wheel(frame, "suspension.norm-suspension-travel", i));
  const millimeters = WHEELS.map((_, i) => { const v = wheel(frame, "suspension.suspension-travel-m", i); return v == null ? null : v * 1000; });
  const values = normalized.some((v) => v != null) ? normalized : millimeters.map((v) => (v == null ? null : v / 100));
  const hasMm = millimeters.some((v) => v != null);
  const left = values[0] != null && values[2] != null ? ((values[0] + values[2]) / 2) : null;
  const front = values[0] != null && values[1] != null ? (values[0] + values[1]) / 2 : null;
  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;
  return <WheelTable title={m.dataguide_suspension()} borderTop rows={[{
    label: m.dataguide_travel(),
    fl: values[0] == null ? unavailable : hasMm ? `${Math.round(millimeters[0]!)}mm` : C(`${(values[0] * 100).toFixed(0)}%`, operatingRangeColor(values[0], [0.25, 0.65, 0.85])),
    fr: values[1] == null ? unavailable : hasMm ? `${Math.round(millimeters[1]!)}mm` : C(`${(values[1] * 100).toFixed(0)}%`, operatingRangeColor(values[1], [0.25, 0.65, 0.85])),
    rl: values[2] == null ? unavailable : hasMm ? `${Math.round(millimeters[2]!)}mm` : C(`${(values[2] * 100).toFixed(0)}%`, operatingRangeColor(values[2], [0.25, 0.65, 0.85])),
    rr: values[3] == null ? unavailable : hasMm ? `${Math.round(millimeters[3]!)}mm` : C(`${(values[3] * 100).toFixed(0)}%`, operatingRangeColor(values[3], [0.25, 0.65, 0.85])),
  }, { label: m.analyse_suspension_compression_bias(), fl: front == null ? unavailable : `${m.analyse_suspension_front()} ${(front * 100).toFixed(0)}%`, rl: left == null ? unavailable : `${m.analyse_suspension_left()} ${(left * 100).toFixed(0)}%`, fr: "", rr: "", span2: true }]} />;
}
