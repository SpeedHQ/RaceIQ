import { suspColor } from "@/lib/colors";

export function SuspBar({ norm, thresholds }: { norm: number; thresholds: number[] }) {
  const pct = Math.min(norm * 100, 100);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-4 h-16 bg-slate-800/80 border border-slate-600/50 rounded-sm overflow-hidden relative">
        <div
          className={`absolute top-0 w-full rounded-sm ${suspColor(norm, thresholds)}`}
          style={{ height: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] font-mono text-app-text-muted tabular-nums w-7 text-center">{pct.toFixed(0)}%</span>
    </div>
  );
}
