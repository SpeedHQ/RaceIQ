import { getSteeringLock } from "./Settings";

interface Props {
  steer: number; // signed int8: -128 to 127, 0 = center
  rpm?: number;
  maxRpm?: number;
}

export function SteeringWheel({ steer, rpm, maxRpm }: Props) {
  const lock = getSteeringLock();
  const normalized = steer / 127;
  const degrees = normalized * (lock / 2);
  const rpmPct = rpm && maxRpm && maxRpm > 0 ? (rpm / maxRpm) * 100 : 0;

  return (
    <div className="flex flex-col items-center">
      {/* Shift light LEDs — full width bar */}
      {rpm != null && maxRpm != null && (
        <div className="w-full">
          <div className="flex justify-between text-[10px] text-app-text-muted font-mono mb-0.5">
            <span>RPM</span>
            <span className="tabular-nums">{rpm.toFixed(0)} / {maxRpm.toFixed(0)}</span>
          </div>
          <div className="flex gap-[2px] w-full">
            {Array.from({ length: 30 }, (_, i) => {
              const segPct = ((i + 1) / 30) * 100;
              const lit = rpmPct >= segPct;
              let bg: string;
              if (segPct <= 40) bg = lit ? "bg-green-400" : "bg-green-400/10";
              else if (segPct <= 60) bg = lit ? "bg-green-400" : "bg-green-400/10";
              else if (segPct <= 75) bg = lit ? "bg-amber-400" : "bg-amber-400/10";
              else if (segPct <= 90) bg = lit ? "bg-red-500" : "bg-red-500/10";
              else bg = lit ? "bg-blue-500 animate-pulse" : "bg-blue-500/10";
              return <div key={i} className={`flex-1 h-3 ${bg}`} />;
            })}
          </div>
        </div>
      )}
      <div className="relative w-36 h-28">
        <svg
          viewBox="0 0 140 110"
          className="w-full h-full"
          style={{ transform: `rotate(${degrees}deg)` }}
        >
          {/* F1 wheel shape — flat top, flat bottom, curved grips */}
          <defs>
            <linearGradient id="grip-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#475569" />
              <stop offset="100%" stopColor="#334155" />
            </linearGradient>
            <linearGradient id="hub-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#1e293b" />
              <stop offset="100%" stopColor="#0f172a" />
            </linearGradient>
          </defs>

          {/* Left grip */}
          <path
            d="M 18 30 Q 6 55 18 80"
            fill="none"
            stroke="url(#grip-grad)"
            strokeWidth="10"
            strokeLinecap="round"
          />
          {/* Right grip */}
          <path
            d="M 122 30 Q 134 55 122 80"
            fill="none"
            stroke="url(#grip-grad)"
            strokeWidth="10"
            strokeLinecap="round"
          />
          {/* Top flat bar */}
          <path
            d="M 18 30 L 55 22 L 85 22 L 122 30"
            fill="none"
            stroke="#475569"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Bottom flat bar — narrower on F1 */}
          <path
            d="M 30 78 L 55 84 L 85 84 L 110 78"
            fill="none"
            stroke="#475569"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Center hub plate */}
          <rect
            x="38" y="32" width="64" height="46" rx="8"
            fill="url(#hub-grad)"
            stroke="#334155"
            strokeWidth="1.5"
          />

          {/* Hub details — top row buttons */}
          <circle cx="52" cy="42" r="3.5" fill="#ef4444" opacity="0.7" />
          <circle cx="64" cy="42" r="3.5" fill="#3b82f6" opacity="0.7" />
          <circle cx="76" cy="42" r="3.5" fill="#eab308" opacity="0.7" />
          <circle cx="88" cy="42" r="3.5" fill="#22c55e" opacity="0.7" />

          {/* Mini display area */}
          <rect x="48" y="50" width="44" height="16" rx="3" fill="#0f172a" stroke="#1e293b" strokeWidth="1" />
          <text x="70" y="62" textAnchor="middle" fill="#22d3ee" fontSize="10" fontFamily="monospace" fontWeight="bold">
            {Math.abs(degrees) < 1 ? "0" : `${degrees > 0 ? "+" : ""}${degrees.toFixed(0)}`}°
          </text>

          {/* Bottom row — rotary dials */}
          <circle cx="56" cy="73" r="3" fill="none" stroke="#475569" strokeWidth="1.5" />
          <line x1="56" y1="70" x2="56" y2="73" stroke="#94a3b8" strokeWidth="1" />
          <circle cx="70" cy="73" r="3" fill="none" stroke="#475569" strokeWidth="1.5" />
          <line x1="70" y1="70" x2="70" y2="73" stroke="#94a3b8" strokeWidth="1" />
          <circle cx="84" cy="73" r="3" fill="none" stroke="#475569" strokeWidth="1.5" />
          <line x1="84" y1="70" x2="84" y2="73" stroke="#94a3b8" strokeWidth="1" />

          {/* Top center marker (12 o'clock reference) — drawn outside rotation context */}
        </svg>

      </div>
    </div>
  );
}
