import { getSteeringLock, getWheelStyle } from "./Settings";

interface Props {
  steer: number; // signed int8: -128 to 127, 0 = center
  rpm?: number;
  maxRpm?: number;
  size?: number; // px, default 160
}

export function SteeringWheel({ steer, rpm, maxRpm, size = 160 }: Props) {
  const lock = getSteeringLock();
  const wheelSrc = getWheelStyle();
  const normalized = steer / 127;
  const degrees = normalized * (lock / 2);
  const rpmPct = rpm && maxRpm && maxRpm > 0 ? (rpm / maxRpm) * 100 : 0;

  const imgSrc = wheelSrc;

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
      <div
        className="relative flex items-center justify-center"
        style={{ width: size, height: size, transform: `rotate(${degrees}deg)` }}
      >
        <img
          src={imgSrc}
          alt="steering wheel"
          className="w-full h-full object-contain"
          onError={(e) => { (e.target as HTMLImageElement).src = "/wheels/Simple.svg"; }}
        />
      </div>
    </div>
  );
}
