import { useTelemetryStore } from "../../stores/telemetry";
import { formatLapTime } from "../../lib/format";
import { DashShell } from "./dash-shell";

function formatDelta(seconds: number): string {
  const sign = seconds >= 0 ? "+" : "-";
  const abs = Math.abs(seconds);
  return `${sign}${abs.toFixed(3)}`;
}

export function LapDash() {
  const packet = useTelemetryStore((s) => s.packet);

  const current = packet?.CurrentLap ?? 0;
  const last = packet?.LastLap ?? 0;
  const best = packet?.BestLap ?? 0;
  const lapNumber = packet?.LapNumber ?? 0;

  const hasBest = best > 0;
  const hasLast = last > 0;
  const delta = hasBest && hasLast ? last - best : null;
  const deltaColor =
    delta === null
      ? "text-white/40"
      : delta < 0
        ? "text-emerald-400"
        : delta > 0
          ? "text-red-400"
          : "text-white/80";

  return (
    <DashShell>
      <div className="h-full w-full flex flex-col justify-center gap-5 px-8">
        <Row
          label="LAP"
          value={lapNumber > 0 ? String(lapNumber) : "--"}
          valueClass="text-white"
          big
        />
        <Row
          label="CURRENT"
          value={current > 0 ? formatLapTime(current) : "--:--.---"}
          valueClass="text-white"
          big
        />
        <Row
          label="LAST"
          value={hasLast ? formatLapTime(last) : "--:--.---"}
          valueClass="text-white/80"
        />
        <Row
          label="BEST"
          value={hasBest ? formatLapTime(best) : "--:--.---"}
          valueClass="text-amber-300"
        />
        <Row
          label="DELTA"
          value={delta === null ? "--" : formatDelta(delta)}
          valueClass={deltaColor}
          big
        />
      </div>
    </DashShell>
  );
}

function Row({
  label,
  value,
  valueClass,
  big,
}: {
  label: string;
  value: string;
  valueClass: string;
  big?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/10 pb-2">
      <div
        className="text-white/50 tracking-widest uppercase"
        style={{ fontSize: "clamp(0.9rem, 2.5vh, 1.5rem)" }}
      >
        {label}
      </div>
      <div
        className={`font-black leading-none ${valueClass}`}
        style={{ fontSize: big ? "clamp(3rem, 10vh, 7rem)" : "clamp(2rem, 7vh, 5rem)" }}
      >
        {value}
      </div>
    </div>
  );
}
