interface RevBarProps {
  rpm: number;
  idle: number;
  max: number;
  segments?: number;
  className?: string;
}

function segmentColor(segPct: number): string {
  if (segPct >= 0.95) return "#ff2d2d";
  if (segPct >= 0.85) return "#ff6a00";
  if (segPct >= 0.7) return "#ffd400";
  return "#22d172";
}

export function RevBar({ rpm, idle, max, segments = 100, className = "" }: RevBarProps) {
  const span = Math.max(max - idle, 1);
  const pct = Math.max(0, Math.min(1, (rpm - idle) / span));
  const litCount = Math.floor(pct * segments);
  const shiftNow = pct >= 0.97;

  return (
    <div className={`flex h-full w-full gap-[1px] ${shiftNow ? "animate-pulse" : ""} ${className}`}>
      {Array.from({ length: segments }).map((_, i) => {
        const segPct = (i + 1) / segments;
        const lit = i < litCount;
        const color = segmentColor(segPct);
        return (
          <div
            key={i}
            className="flex-1 rounded-[2px] transition-opacity duration-75"
            style={{
              background: lit ? color : "rgba(255,255,255,0.06)",
              boxShadow: lit ? `0 0 8px ${color}66` : "none",
              opacity: lit ? 1 : 0.6,
            }}
          />
        );
      })}
    </div>
  );
}
