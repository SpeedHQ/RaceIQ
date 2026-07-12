import type { F1ExtendedData } from "@shared/types";

export function F1DrsIndicator({ f1 }: { f1: F1ExtendedData }) {
  const active = f1.drsActivated;
  const allowed = f1.drsAllowed;
  const approaching = f1.drsZoneApproaching;

  let label = "DRS";
  let bg = "bg-zinc-800";
  let text = "text-zinc-500";

  if (active) {
    label = "DRS OPEN";
    bg = "bg-green-600";
    text = "text-white";
  } else if (allowed) {
    label = "DRS READY";
    bg = "bg-green-900";
    text = "text-green-300";
  } else if (approaching) {
    label = "DRS ZONE";
    bg = "bg-yellow-900";
    text = "text-yellow-300";
  }

  return <div className={`rounded-lg px-4 py-2 text-center font-bold text-sm ${bg} ${text} transition-colors`}>{label}</div>;
}
