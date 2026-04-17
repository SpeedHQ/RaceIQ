import { useEffect, useState } from "react";

interface RevBarProps {
  rpm: number;
  idle: number;
  max: number;
  segments?: number;
  className?: string;
}

function barColor(pct: number): string {
  if (pct >= 0.97) return "#ff2d2d";
  if (pct >= 0.9) return "#ff6a00";
  if (pct >= 0.75) return "#ffd400";
  return "#22d172";
}

/** Toggle rapidly while redlining for a strobe effect. */
function useRedlineStrobe(active: boolean, intervalMs = 90): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!active) {
      setOn(true);
      return;
    }
    const id = window.setInterval(() => setOn((o) => !o), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return on;
}

export function RevBar({ rpm, idle, max, segments = 100, className = "" }: RevBarProps) {
  const span = Math.max(max - idle, 1);
  const pct = Math.max(0, Math.min(1, (rpm - idle) / span));
  const litCount = Math.floor(pct * segments);
  const redlining = pct >= 0.97;
  const strobeOn = useRedlineStrobe(redlining);

  const baseColor = barColor(pct);
  // While redlining, alternate between red and orange instead of blinking off.
  const color = redlining && !strobeOn ? "#ff6a00" : baseColor;
  const litBg = color;
  const litShadow = `0 0 8px ${color}66`;

  return (
    <div className={`flex h-full w-full gap-[1px] ${className}`}>
      {Array.from({ length: segments }).map((_, i) => {
        const lit = i < litCount;
        return (
          <div
            key={i}
            className="flex-1 rounded-[2px] transition-colors duration-75"
            style={{
              background: lit ? litBg : "rgba(255,255,255,0.06)",
              boxShadow: lit ? litShadow : "none",
              opacity: lit ? 1 : 0.6,
            }}
          />
        );
      })}
    </div>
  );
}
