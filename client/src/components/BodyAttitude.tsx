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
      {/* Rear view — shows roll */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 70 50" width={70} height={50}>
          <line x1={5} y1={25} x2={65} y2={25} stroke="rgba(100,116,139,0.15)" strokeWidth={0.5} />
          <g transform={`rotate(${clampRoll}, 35, 30)`}>
            <rect x={15} y={22} width={40} height={14} rx={3} fill="none" stroke="rgba(34,211,238,0.5)" strokeWidth={1.5} />
            <path d="M22 22 L25 14 L45 14 L48 22" fill="none" stroke="rgba(34,211,238,0.5)" strokeWidth={1.5} />
            <rect x={11} y={32} width={8} height={5} rx={1.5} fill="rgba(34,211,238,0.3)" stroke="rgba(34,211,238,0.5)" strokeWidth={1} />
            <rect x={51} y={32} width={8} height={5} rx={1.5} fill="rgba(34,211,238,0.3)" stroke="rgba(34,211,238,0.5)" strokeWidth={1} />
          </g>
          <text x={35} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">Roll {roll.toFixed(1)}°</text>
        </svg>
      </div>

      {/* Side view — shows pitch */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 70 50" width={70} height={50}>
          <line x1={5} y1={25} x2={65} y2={25} stroke="rgba(100,116,139,0.15)" strokeWidth={0.5} />
          <g transform={`rotate(${-clampPitch}, 35, 28)`}>
            <rect x={10} y={20} width={50} height={12} rx={3} fill="none" stroke="rgba(251,191,36,0.5)" strokeWidth={1.5} />
            <path d="M42 20 L48 12 L55 12 L55 20" fill="none" stroke="rgba(251,191,36,0.5)" strokeWidth={1.5} />
            <circle cx={20} cy={34} r={4} fill="rgba(251,191,36,0.3)" stroke="rgba(251,191,36,0.5)" strokeWidth={1} />
            <circle cx={50} cy={34} r={4} fill="rgba(251,191,36,0.3)" stroke="rgba(251,191,36,0.5)" strokeWidth={1} />
          </g>
          <text x={35} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">Pitch {pitch.toFixed(1)}°</text>
        </svg>
      </div>

      {/* Yaw compass */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 40 50" width={40} height={50}>
          <circle cx={20} cy={22} r={14} fill="none" stroke="rgba(100,116,139,0.2)" strokeWidth={0.8} />
          <g transform={`rotate(${yaw}, 20, 22)`}>
            <line x1={20} y1={22} x2={20} y2={10} stroke="rgba(52,211,153,0.7)" strokeWidth={1.5} />
            <polygon points="20,8 17,13 23,13" fill="rgba(52,211,153,0.7)" />
          </g>
          <text x={20} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">Yaw {yaw.toFixed(0)}°</text>
        </svg>
      </div>
    </div>
  );
}
