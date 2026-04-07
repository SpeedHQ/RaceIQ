interface Props {
  yaw: number; // radians, Forza convention: 0 = +Z, positive = clockwise from above
}

const CARDINALS = [
  { label: "N", deg: 0 },
  { label: "E", deg: 90 },
  { label: "S", deg: 180 },
  { label: "W", deg: 270 },
];

export function Compass({ yaw }: Props) {
  const headingDeg = ((yaw * 180) / Math.PI + 360) % 360;

  // Show a horizontal strip ±90° around current heading
  const stripWidth = 180;
  const center = headingDeg;

  const visibleMarkers: { label: string; offset: number }[] = [];
  for (const c of CARDINALS) {
    let diff = c.deg - center;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    if (Math.abs(diff) <= stripWidth / 2) {
      visibleMarkers.push({ label: c.label, offset: diff });
    }
  }

  // Generate tick marks every 10°
  const ticks: { deg: number; offset: number; major: boolean }[] = [];
  for (let d = 0; d < 360; d += 10) {
    let diff = d - center;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    if (Math.abs(diff) <= stripWidth / 2) {
      ticks.push({ deg: d, offset: diff, major: d % 30 === 0 });
    }
  }

  const toX = (offset: number) => 50 + (offset / (stripWidth / 2)) * 46;

  return (
    <div className="flex flex-col items-center w-full">
      <svg viewBox="0 0 100 28" className="w-full" style={{ maxWidth: 160 }}>
        {/* Track background */}
        <rect x="2" y="4" width="96" height="16" rx="2" fill="#0f172a" fillOpacity="0.5" stroke="#334155" strokeWidth="0.5" />

        {/* Ticks — skip where cardinals are */}
        {ticks.filter(t => !visibleMarkers.some(m => Math.abs(toX(m.offset) - toX(t.offset)) < 4)).map((t) => (
          <line
            key={t.deg}
            x1={toX(t.offset)}
            y1={t.major ? 6 : 8}
            x2={toX(t.offset)}
            y2={t.major ? 18 : 16}
            stroke={t.major ? "#64748b" : "#334155"}
            strokeWidth={t.major ? 0.8 : 0.4}
          />
        ))}

        {/* Cardinal labels */}
        {visibleMarkers.map(({ label, offset }) => (
          <text
            key={label}
            x={toX(offset)}
            y={13.5}
            textAnchor="middle"
            dominantBaseline="central"
            fill={label === "N" ? "#ef4444" : "#94a3b8"}
            fontSize={label === "N" ? 8 : 7}
            fontWeight="bold"
            fontFamily="monospace"
          >
            {label}
          </text>
        ))}

        {/* Center indicator */}
        <polygon points="50,3 48,0 52,0" fill="#22d3ee" />
        <line x1="50" y1="3" x2="50" y2="5" stroke="#22d3ee" strokeWidth="1" />
      </svg>
      <div className="text-[10px] font-mono text-app-text-secondary tabular-nums -mt-0.5">
        {headingDeg.toFixed(0)}°
      </div>
    </div>
  );
}
