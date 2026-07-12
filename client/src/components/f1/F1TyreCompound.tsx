import type { F1ExtendedData } from "@shared/types";

const COMPOUND_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  soft: { bg: "bg-red-600", text: "text-white", border: "border-red-500" },
  medium: { bg: "bg-yellow-500", text: "text-black", border: "border-yellow-400" },
  hard: { bg: "bg-white", text: "text-black", border: "border-zinc-300" },
  inter: { bg: "bg-green-500", text: "text-white", border: "border-green-400" },
  wet: { bg: "bg-blue-500", text: "text-white", border: "border-blue-400" },
  unknown: { bg: "bg-zinc-700", text: "text-zinc-400", border: "border-zinc-600" },
};

export function F1TyreCompound({ f1 }: { f1: F1ExtendedData }) {
  const compound = f1.tyreCompound || "unknown";
  const colors = COMPOUND_COLORS[compound] ?? COMPOUND_COLORS.unknown;

  return (
    <div className="flex items-center gap-2">
      <div className={`w-8 h-8 rounded-full ${colors.bg} ${colors.border} border-2 flex items-center justify-center`}>
        <span className={`text-xs font-black ${colors.text}`}>{compound[0]?.toUpperCase() ?? "?"}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-xs text-zinc-300 font-medium capitalize">{compound}</span>
        <span className="text-[10px] text-zinc-500">
          {f1.tyreAge} lap{f1.tyreAge !== 1 ? "s" : ""} old
        </span>
      </div>
    </div>
  );
}
