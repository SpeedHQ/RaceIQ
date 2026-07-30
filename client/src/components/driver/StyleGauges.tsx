import type { StyleAxes } from "../../../../server/ai/driver-profile-aggregate";

interface CompactGaugeProps {
  label: string;
  value: number | null;
  display: string;
  width: number;
  tone?: "accent" | "good" | "warn";
}

function CompactGauge({ label, value, display, width, tone = "accent" }: CompactGaugeProps) {
  const fill = tone === "good" ? "bg-dynamics-green" : tone === "warn" ? "bg-dynamics-yellow" : "bg-app-accent";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-x-2 gap-y-1">
      <span className="text-xs text-app-text-muted">{label}</span>
      <b className="text-right text-xs tabular-nums text-app-text">{value === null ? "—" : display}</b>
      <div className="h-1.5 rounded-full bg-app-surface-alt">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${value === null ? 0 : Math.max(4, Math.min(100, width))}%` }} />
      </div>
      <span />
    </div>
  );
}

export function StyleGauges({ style }: { style: StyleAxes; recentNormalizedCount?: number }) {
  const grip = style.gripUtilMedian;
  const balance = style.balanceMedianDeg;
  const control = style.controlLossFraction;
  const steering = style.steerReversalsPerS;
  const consistency = style.consistency;
  return (
    <div className="mt-4 space-y-3">
      <CompactGauge label="Grip usage" value={grip} display={grip === null ? "" : grip.toFixed(2)} width={grip === null ? 0 : (grip / 1.1) * 100} />
      <CompactGauge label="Balance" value={balance} display={balance === null ? "" : `${balance > 0 ? "+" : ""}${balance.toFixed(1)}°`} width={balance === null ? 0 : 50 + (balance / 8) * 25} />
      <CompactGauge label="Control loss" value={control} display={control === null ? "" : `${(control * 100).toFixed(1)}%`} width={control === null ? 0 : (control / 0.12) * 100} tone="good" />
      <CompactGauge label="Steering variability" value={steering} display={steering === null ? "" : `${steering.toFixed(1)}/s`} width={steering === null ? 0 : (steering / 5) * 100} />
      <CompactGauge label="Consistency" value={consistency} display={consistency === null ? "" : consistency.toFixed(0)} width={consistency ?? 0} tone="good" />
    </div>
  );
}
