interface Props {
  yaw: number; // radians, Forza convention: 0 = +Z, positive = clockwise from above
}

const CARDINAL = [
  { label: "N", angle: 0 },
  { label: "E", angle: 90 },
  { label: "S", angle: 180 },
  { label: "W", angle: 270 },
];

const TICKS = Array.from({ length: 36 }, (_, i) => i * 10); // every 10°

export function Compass({ yaw }: Props) {
  // Convert Forza yaw to compass heading in degrees
  // Forza: 0 = +Z (north-ish), positive = clockwise → maps directly to compass
  const headingDeg = ((yaw * 180) / Math.PI + 360) % 360;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-20 h-20">
        <svg viewBox="0 0 100 100" className="w-full h-full">
          {/* Outer ring */}
          <circle cx="50" cy="50" r="46" fill="none" stroke="#334155" strokeWidth="1.5" />
          <circle cx="50" cy="50" r="38" fill="#0f172a" fillOpacity="0.5" stroke="none" />

          {/* Rotating compass rose */}
          <g transform={`rotate(${-headingDeg}, 50, 50)`}>
            {/* Minor ticks every 10° */}
            {TICKS.map((deg) => {
              const isMajor = deg % 90 === 0;
              const isMinor45 = deg % 45 === 0;
              const r1 = isMajor ? 36 : isMinor45 ? 38 : 40;
              const r2 = 44;
              const rad = (deg * Math.PI) / 180;
              return (
                <line
                  key={deg}
                  x1={50 + r1 * Math.sin(rad)}
                  y1={50 - r1 * Math.cos(rad)}
                  x2={50 + r2 * Math.sin(rad)}
                  y2={50 - r2 * Math.cos(rad)}
                  stroke={isMajor ? "#94a3b8" : "#475569"}
                  strokeWidth={isMajor ? 1.5 : 0.5}
                />
              );
            })}

            {/* Cardinal labels */}
            {CARDINAL.map(({ label, angle }) => {
              const rad = (angle * Math.PI) / 180;
              const r = 30;
              return (
                <text
                  key={label}
                  x={50 + r * Math.sin(rad)}
                  y={50 - r * Math.cos(rad) + 3}
                  textAnchor="middle"
                  fill={label === "N" ? "#ef4444" : "#94a3b8"}
                  fontSize={label === "N" ? 9 : 7}
                  fontWeight="bold"
                  fontFamily="monospace"
                >
                  {label}
                </text>
              );
            })}
          </g>

          {/* Fixed heading pointer (top, pointing up) */}
          <polygon
            points="50,10 46,20 54,20"
            fill="#22d3ee"
          />
          <line x1="50" y1="20" x2="50" y2="38" stroke="#22d3ee" strokeWidth="1.5" />

          {/* Center dot */}
          <circle cx="50" cy="50" r="2.5" fill="#22d3ee" />
        </svg>
      </div>
      <div className="text-[10px] font-mono text-app-text-secondary tabular-nums">
        {headingDeg.toFixed(0)}°
      </div>
    </div>
  );
}
