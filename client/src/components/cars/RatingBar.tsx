export function RatingBar({ value, max = 10 }: { value: number; max?: number }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1 bg-app-border rounded-full overflow-hidden">
        <div className="h-full bg-app-accent rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-app-caption tabular-nums text-app-text/90 w-5">{value.toFixed(1)}</span>
    </div>
  );
}
