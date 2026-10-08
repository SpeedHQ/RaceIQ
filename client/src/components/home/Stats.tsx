import { ToggleGroup03 } from "@/components/shadcn-studio/toggle-group/toggle-group-03";
import { m } from "@/paraglide/messages";
import type { PeriodKey } from "./types";


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

