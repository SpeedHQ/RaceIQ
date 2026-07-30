import type { F1ExtendedData } from "@shared/types";

export function F1TyreCompound({ f1 }: { f1: F1ExtendedData }) {
  const compound = f1.tyreCompound || "unknown";

  return (
    <div className="flex items-center gap-2">
      <div className="tire-compound-wheel w-8 h-8 rounded-full border-2 flex items-center justify-center" data-tire-compound={compound.toLowerCase()}>
        <span className="text-xs font-black">{compound[0]?.toUpperCase() ?? "?"}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-xs text-app-text-secondary font-medium capitalize">{compound}</span>
        <span className="text-app-caption text-app-text-dim">
          {f1.tyreAge} lap{f1.tyreAge !== 1 ? "s" : ""} old
        </span>
      </div>
    </div>
  );
}
