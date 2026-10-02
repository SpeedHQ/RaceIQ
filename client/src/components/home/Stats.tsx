import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { PeriodKey, PeriodStats } from "./types";

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-4">
      <div className="text-app-caption text-app-text/90 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-3xl font-mono font-black tabular-nums leading-none ${color ?? "text-app-text/90"}`}>{value}</div>
      {sub && <div className="text-xs text-app-text/90 mt-1">{sub}</div>}
    </div>
  );
}

function formatDrivenTime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function PeriodStatsPanel({ periodTab, periodStats, onPeriodTabChange }: { periodTab: PeriodKey; periodStats: PeriodStats; onPeriodTabChange: (period: PeriodKey) => void }) {
  const data = periodStats[periodTab];
  const periodLabels: ReadonlyArray<readonly [PeriodKey, string]> = [
    ["today", m.home_period_today()],
    ["week", m.home_period_week()],
    ["month", m.home_period_month()],
    ["year", m.home_period_year()],
    ["allTime", m.home_period_all_time()],
  ];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {periodLabels.map(([key, label]) => (
          <Button
            variant="app-ghost"
            size="app-sm"
            key={key}
            onClick={() => onPeriodTabChange(key)}
            className={`!px-3 !py-1.5 text-xs font-semibold transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text/90 hover:text-app-text"}`}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 @3xl/workspace:grid-cols-5">
        <StatCard label={m.label_sessions()} value={`${data.sessions}`} />
        <StatCard label={m.label_laps()} value={`${data.laps}`} />
        <StatCard label={m.label_tracks()} value={`${data.tracks}`} />
        <StatCard label={m.label_cars()} value={`${data.cars}`} />
        {data.totalTime > 0 && <StatCard label={m.home_stat_time_driven()} value={formatDrivenTime(data.totalTime)} color="text-app-accent" />}
      </div>
    </>
  );
}
