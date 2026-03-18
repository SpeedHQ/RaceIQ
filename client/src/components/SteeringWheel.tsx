interface Props {
  steer: number; // 0-255, 127 = center
}

export function SteeringWheel({ steer }: Props) {
  // Convert 0-255 to degrees: 127=0°, 0=-540°, 255=+540° (full lock ~1.5 turns)
  const normalized = (steer - 127) / 128;
  const degrees = normalized * 540;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="text-xs text-slate-500 uppercase tracking-wider">Steering</div>
      <div className="relative w-20 h-20">
        <svg
          viewBox="0 0 100 100"
          className="w-full h-full"
          style={{ transform: `rotate(${degrees}deg)` }}
        >
          {/* Outer ring */}
          <circle
            cx="50"
            cy="50"
            r="44"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            className="text-slate-600"
          />
          {/* Grip highlights */}
          <path
            d="M 12 35 A 44 44 0 0 1 88 35"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            className="text-slate-400"
          />
          <path
            d="M 88 65 A 44 44 0 0 1 12 65"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            className="text-slate-400"
          />
          {/* Center hub */}
          <circle cx="50" cy="50" r="12" fill="currentColor" className="text-slate-700" />
          {/* Top marker */}
          <line
            x1="50"
            y1="6"
            x2="50"
            y2="16"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            className="text-cyan-400"
          />
          {/* Spokes */}
          <line x1="50" y1="38" x2="50" y2="18" stroke="currentColor" strokeWidth="2.5" className="text-slate-500" />
          <line x1="38" y1="50" x2="18" y2="50" stroke="currentColor" strokeWidth="2.5" className="text-slate-500" />
          <line x1="62" y1="50" x2="82" y2="50" stroke="currentColor" strokeWidth="2.5" className="text-slate-500" />
        </svg>
      </div>
      <div className="text-xs font-mono text-slate-400 tabular-nums">
        {degrees > 0 ? "+" : ""}{degrees.toFixed(0)}°
      </div>
    </div>
  );
}
