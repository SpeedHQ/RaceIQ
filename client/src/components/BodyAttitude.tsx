import type { TelemetryPacket } from "@shared/types";

const toDeg = 180 / Math.PI;

/**
 * BodyAttitude — Three SVG mini-views showing car orientation:
 * 1. Rear view: car body rotates with roll angle (weight transfer in corners)
 * 2. Side view: car body rotates with pitch angle (braking/acceleration dive)
 * 3. Compass: arrow rotates with yaw heading
 */
export function BodyAttitude({ packet }: { packet: TelemetryPacket }) {
  const roll = packet.Roll * toDeg;
  const pitch = packet.Pitch * toDeg;
  const yaw = packet.Yaw * toDeg;
  const clampRoll = Math.max(-25, Math.min(25, roll));
  const clampPitch = Math.max(-15, Math.min(15, pitch));

  return (
    <div className="flex items-center gap-3">
      {/* Attitude indicator — roll + pitch combined */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 -6 50 56" width={130} height={143}>
          <defs>
            <clipPath id="ati-clip"><rect x={8} y={4} width={34} height={36} rx={4} /></clipPath>
          </defs>
          <g clipPath="url(#ati-clip)">
            <g transform={`rotate(${clampRoll}, 25, 22)`}>
              {/* Sky */}
              <rect x={-10} y={-30} width={70} height={52 + clampPitch * 1.2} fill="rgba(56,130,202,0.35)" />
              {/* Ground */}
              <rect x={-10} y={22 + clampPitch * 1.2} width={70} height={60} fill="rgba(139,90,43,0.35)" />
              {/* Horizon line */}
              <line x1={-10} y1={22 + clampPitch * 1.2} x2={60} y2={22 + clampPitch * 1.2} stroke="rgba(255,255,255,0.6)" strokeWidth={0.5} />
              {/* Pitch ladder lines — every 2.5° */}
              {[-10, -7.5, -5, -2.5, 2.5, 5, 7.5, 10].map(d => {
                const major = d % 5 === 0;
                const x1 = major ? 17 : 20;
                const x2 = major ? 33 : 30;
                return (
                  <line key={d} x1={x1} y1={22 + clampPitch * 1.2 - d * 1.2} x2={x2} y2={22 + clampPitch * 1.2 - d * 1.2} stroke={`rgba(255,255,255,${major ? 0.35 : 0.18})`} strokeWidth={major ? 0.5 : 0.3} />
                );
              })}
            </g>
          </g>
          {/* Bezel */}
          <rect x={8} y={4} width={34} height={36} rx={4} fill="none" stroke="rgba(100,116,139,0.4)" strokeWidth={1} />
          {/* Bank angle tick marks — every 5° */}
          {[-30, -25, -20, -15, -10, -5, 5, 10, 15, 20, 25, 30].map(a => {
            const major = a % 10 === 0;
            return (
              <line key={a} x1={25} y1={4.5} x2={25} y2={major ? 8.5 : 7} stroke={`rgba(255,255,255,${major ? 0.5 : 0.25})`} strokeWidth={major ? 0.6 : 0.35} transform={`rotate(${a}, 25, 22)`} />
            );
          })}
          {/* Fixed aircraft reference wings */}
          <line x1={9} y1={22} x2={19} y2={22} stroke="rgba(251,191,36,0.9)" strokeWidth={0.8} />
          <line x1={31} y1={22} x2={41} y2={22} stroke="rgba(251,191,36,0.9)" strokeWidth={0.8} />
          <circle cx={25} cy={22} r={1} fill="rgba(251,191,36,0.9)" />
          {/* Roll pointer at top */}
          <polygon points="25,3 23,6 27,6" fill="rgba(255,255,255,0.5)" />
          {/* Yaw heading at top */}
          <text x={25} y={2.5} textAnchor="middle" fill="#94a3b8" fontSize={5} fontFamily="monospace">{yaw.toFixed(0)}°</text>
          <text x={25} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">R{roll.toFixed(0)}° P{pitch.toFixed(0)}°</text>
        </svg>
      </div>
    </div>
  );
}
