import { useEffect, useState } from "react";

interface RevBarProps {
  rpm: number;
  idle: number;
  max: number;
  segments?: number;
  className?: string;
}

function barColor(pct: number): string {
  if (pct >= 0.97) return "var(--rev-limit)";
  if (pct >= 0.9) return "var(--rev-warning)";
  if (pct >= 0.75) return "var(--rev-high)";
  return "var(--rev-normal)";
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Toggle rapidly while redlining for a strobe effect. */
function useRedlineStrobe(active: boolean, intervalMs = 90): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    // Skip the strobe when the user prefers reduced motion. This also keeps
    // the bar deterministic for snapshot tests (otherwise the captured frame
    // lands on a random strobe phase → red/orange flicker in the diff).
    if (!active || prefersReducedMotion()) {
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
  const color = redlining && !strobeOn ? "var(--rev-warning)" : baseColor;
  const litBg = color;
  const litShadow = `0 0 8px color-mix(in srgb, ${color} 40%, transparent)`;

  return (
    <div className={`flex h-full w-full gap-[1px] ${className}`}>
      {Array.from({ length: segments }).map((_, i) => {
        const lit = i < litCount;
        return (
          <div
            // oxlint-disable-next-line suspicious/noArrayIndexKey: fixed-length static segment list, never reordered
            key={i}
            className="flex-1 rounded-[2px] transition-colors duration-75"
            style={{
              background: lit ? litBg : "var(--app-text)",
              boxShadow: lit ? litShadow : "none",
              opacity: lit ? 1 : 0.06,
            }}
          />
        );
      })}
    </div>
  );
}
