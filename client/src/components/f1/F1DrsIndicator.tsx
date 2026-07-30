import type { F1ExtendedData } from "@shared/types";

export function F1DrsIndicator({ f1 }: { f1: F1ExtendedData }) {
  const active = f1.drsActivated;
  const allowed = f1.drsAllowed;
  const approaching = f1.drsZoneApproaching;

  let label = "DRS";
  let bg = "bg-app-surface-alt";
  let text = "text-app-text-dim";

  if (active) {
    label = "DRS OPEN";
    bg = "bg-(--telemetry-drs)";
    text = "text-app-on-filled";
  } else if (allowed) {
    label = "DRS READY";
    bg = "bg-(--telemetry-drs)/20";
    text = "text-(--telemetry-drs)";
  } else if (approaching) {
    label = "DRS ZONE";
    bg = "bg-status-warning/20";
    text = "text-status-warning";
  }

  return <div className={`rounded-lg px-4 py-2 text-center font-bold text-sm ${bg} ${text} transition-colors`}>{label}</div>;
}
