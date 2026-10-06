import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { PeriodKey, PeriodStats } from "./types";

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-4">
      <div className="mb-1 text-app-label uppercase tracking-app-label text-app-text-muted">{label}</div>
      <div className={`text-app-heading font-mono font-semibold tabular-nums leading-snug ${color ?? "text-app-text/90"}`}>{value}</div>
      {sub && <div className="mt-1 text-app-detail text-app-text/90">{sub}</div>}
    </div>
  );
}

export function formatDrivenTime(seconds: number) {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 60)}m`;
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
            className={`!px-3 !py-1.5 text-app-detail font-semibold transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text/90 hover:text-app-text"}`}
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
