/* ── Legend for the ledgers' "Speed range" column ──
 * Explains the SetupRangeBar markers (min/max rose ticks, amber median
 * diamond, faint per-lap dots) so the bar is readable without hovering for
 * the tooltip. Shared by SectorLedger and CornerLedger. */

export function SpeedRangeLegend() {
  return (
    <div className="flex items-center gap-3 flex-wrap text-[10.5px] text-app-text-dim">
      <span className="uppercase tracking-wider">Speed range</span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-[2px] h-3 bg-rose-400 rounded-full" />
        min / max
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rotate-45 bg-amber-400 rounded-[1px]" />
        median
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-1 h-1 rounded-full bg-white/40" />
        per-lap sample
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-6 h-1.5 rounded-full bg-gradient-to-r from-cyan-400/0 via-cyan-400 to-cyan-400/0" />
        spread density
      </span>
      <span>numbers are km/h</span>
    </div>
  );
}
