import { ToggleGroup03 } from "@/components/shadcn-studio/toggle-group/toggle-group-03";
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

export function PeriodSelector({ periodTab, onPeriodTabChange }: { periodTab: PeriodKey; onPeriodTabChange: (period: PeriodKey) => void }) {
  const periodLabels: ReadonlyArray<readonly [PeriodKey, string]> = [
    ["today", m.home_period_today()],
    ["week", m.home_period_week()],
    ["month", m.home_period_month()],
    ["year", m.home_period_year()],
  ];

  return (
    <div className="max-w-full overflow-x-auto">
      <ToggleGroup03 ariaLabel={m.label_time()} value={periodTab} onValueChange={(value) => onPeriodTabChange(value as PeriodKey)} options={periodLabels.map(([value, label]) => ({ value, label }))} />
    </div>
  );
}

export function PeriodStatsPanel({ periodTab, periodStats }: { periodTab: PeriodKey; periodStats: PeriodStats }) {
  const data = periodStats[periodTab];
  return (
    <div className="@container/stats min-w-0">
      <div className="grid grid-cols-2 gap-3 @min-[640px]/stats:grid-cols-5">
        <StatCard label={m.label_sessions()} value={`${data.sessions}`} />
        <StatCard label={m.label_laps()} value={`${data.laps}`} />
        <StatCard label={m.label_tracks()} value={`${data.tracks}`} />
        <StatCard label={m.label_cars()} value={`${data.cars}`} />
        {data.totalTime > 0 && <StatCard label={m.home_stat_time_driven()} value={formatDrivenTime(data.totalTime)} color="text-app-accent" />}
      </div>
    </div>
  );
}
