/* ── Range bar visual: min/max track with median marker ──
 * Shared between the F1 setup compare tab and the tune-review ledgers. */

export function SetupRangeBar({
  min,
  max,
  median,
  values,
  selected,
  unit,
  showMedianLabel,
}: {
  min: number;
  max: number;
  median: number;
  values: number[];
  selected?: number | null;
  unit?: string;
  showMedianLabel?: boolean;
}) {
  const spread = max - min;
  if (spread === 0) {
    return (
      <div className="relative h-5 mt-1 mb-0.5">
        <div className="absolute inset-x-0 top-2 h-[3px] bg-app-border-input/25 rounded-full" />
        <div className="absolute top-[5px] -translate-x-1/2 left-1/2">
          <div className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
        </div>
      </div>
    );
  }

  const pad = spread * 0.15;
  const lo = min - pad;
  const hi = max + pad;
  const range = hi - lo;
  const pct = (v: number) => ((v - lo) / range) * 100;

  const minPct = pct(min);
  const maxPct = pct(max);
  const medPct = pct(median);

  // Use actual data quartiles for gradient hot spot width
  const sorted = values;
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.ceil(sorted.length * 0.75) - 1];

  const barWidth = maxPct - minPct;
  const rel = (v: number) => (barWidth > 0 ? ((pct(v) - minPct) / barWidth) * 100 : 50);
  const medRel = rel(median);
  const q1Rel = rel(q1);
  const q3Rel = rel(q3);

  return (
    <div className={`relative mt-1 mb-0.5 overflow-visible ${selected != null ? "h-8" : "h-5"}`}>
      {/* Full track — anchored to top */}
      <div className="absolute inset-x-0 top-2 h-[3px] bg-app-border-input/25 rounded-full" />
      {/* Min–Max gradient range */}
      <div
        className="absolute top-0.5 h-3 rounded-full"
        style={{
          left: `${minPct}%`,
          width: `${barWidth}%`,
          background: `linear-gradient(to right, rgba(34,211,238,0) 0%, rgba(34,211,238,0.01) ${q1Rel * 0.6}%, rgba(34,211,238,0.06) ${q1Rel}%, rgba(34,211,238,1) ${medRel}%, rgba(34,211,238,0.06) ${q3Rel}%, rgba(34,211,238,0.01) ${100 - (100 - q3Rel) * 0.6}%, rgba(34,211,238,0) 100%)`,
        }}
      />
      {/* Individual setup dots — skip if at min or max */}
      {values.map((v, i) =>
        v === min || v === max ? null : (
          <div key={i} className="absolute top-[7px] -translate-x-1/2" style={{ left: `${pct(v)}%` }}>
            <div className="w-1 h-1 rounded-full bg-white/40" />
          </div>
        ),
      )}
      {/* Min marker — vertical line */}
      <div className="absolute top-0.5 -translate-x-1/2 w-[2px] h-3 bg-rose-400 rounded-full" style={{ left: `${minPct}%` }} />
      {/* Max marker — vertical line */}
      <div className="absolute top-0.5 -translate-x-1/2 w-[2px] h-3 bg-rose-400 rounded-full" style={{ left: `${maxPct}%` }} />
      {/* Median marker (amber diamond) */}
      <div className="absolute top-[5px] -translate-x-1/2" style={{ left: `${medPct}%` }}>
        <div className="w-2 h-2 bg-amber-400 rotate-45 rounded-[1px] ring-2 ring-black" />
      </div>
      {/* Median value label above the bar */}
      {showMedianLabel && (
        <span className="absolute -top-2.5 -translate-x-1/2 text-[10px] font-mono leading-none text-amber-400 whitespace-nowrap" style={{ left: `${medPct}%` }}>
          {Math.round(median)}
        </span>
      )}
      {/* Selected setup — arrow pointing up + value label beneath the bar */}
      {selected != null && (
        <div className="absolute top-[16px] -translate-x-1/2 z-10 flex flex-col items-center" style={{ left: `${pct(selected)}%` }}>
          <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[6px] border-l-transparent border-r-transparent border-b-emerald-400" />
          <span className="text-[11px] font-mono font-bold text-emerald-400 leading-none mt-0.5 whitespace-nowrap">
            {selected}
            {unit ?? ""}
          </span>
        </div>
      )}
    </div>
  );
}
