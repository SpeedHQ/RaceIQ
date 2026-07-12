import { suspColor } from "@/lib/colors";

/** Standard 0–100% suspension bar. */
function SuspBarStandard({ norm, thresholds }: { norm: number; thresholds: number[] }) {
  const pct = Math.min(norm * 100, 100);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-4 h-16 bg-slate-800/80 border border-slate-600/50 rounded-sm overflow-hidden relative">
        <div className={`absolute top-0 w-full rounded-sm ${suspColor(norm, thresholds)}`} style={{ height: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-app-text-muted tabular-nums w-7 text-center">{pct.toFixed(0)}%</span>
    </div>
  );
}

/**
 * Centered mm suspension bar for AC Evo.
 * norm is encoded as 0.5 = rest, >0.5 = compression, <0.5 = extension.
 * mmTravel is raw signed mm (positive = compressed, negative = extended).
 */
function SuspBarCentered({ norm, thresholds, mmTravel }: { norm: number; thresholds: number[]; mmTravel: number }) {
  const compressedFrac = norm > 0.5 ? Math.min((norm - 0.5) * 2, 1) : 0;
  const extendedFrac = norm < 0.5 ? Math.min((0.5 - norm) * 2, 1) : 0;
  const compressionNorm = compressedFrac; // 0–1 for suspColor
  const mmRounded = Math.round(mmTravel);
  const label = mmRounded >= 0 ? `+${mmRounded}` : `${mmRounded}`;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-4 h-16 bg-slate-800/80 border border-slate-600/50 rounded-sm overflow-hidden relative">
        {/* Rest-position centre line */}
        <div className="absolute top-1/2 w-full h-px bg-slate-500 z-10" />
        {/* Compression fill — upward from centre */}
        {compressedFrac > 0 && <div className={`absolute w-full ${suspColor(compressionNorm, thresholds)}`} style={{ bottom: "50%", height: `${compressedFrac * 50}%` }} />}
        {/* Extension fill — downward from centre */}
        {extendedFrac > 0 && <div className="absolute w-full bg-blue-500/70" style={{ top: "50%", height: `${extendedFrac * 50}%` }} />}
      </div>
      <span className="text-[10px] font-mono text-app-text-muted tabular-nums w-7 text-center">{label}</span>
    </div>
  );
}

export function SuspBar({ norm, thresholds, mmTravel }: { norm: number; thresholds: number[]; mmTravel?: number }) {
  if (mmTravel !== undefined) {
    return <SuspBarCentered norm={norm} thresholds={thresholds} mmTravel={mmTravel} />;
  }
  return <SuspBarStandard norm={norm} thresholds={thresholds} />;
}
