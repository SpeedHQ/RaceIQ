import type { WheelState } from "@/lib/vehicle-dynamics";
import { tireTempColor, slipAngleColor, tireState } from "@/lib/vehicle-dynamics";

/**
 * WheelCard — SVG tire visualization for a single wheel.
 * Shows temp (fill color), wear (fill height from bottom), slip angle (tire rotation),
 * combined grip state, and wheel spin/lockup detection.
 * The tire SVG rotates to match the slip angle, with a dashed line showing
 * the angle between tire heading and actual travel direction.
 * Spin/lockup detection uses animated glow rings and X/arrow overlays.
 */
export function WheelCard({ label, temp, wear, combined, slipAngle, outerSide, wheelState, steerAngle, thresholds, tempFn, tempUnit, onRumble, puddleDepth, brakeTemp }: {
  label: string;
  temp: number;
  wear: number;
  combined: number;
  slipAngle: number;
  outerSide: "left" | "right";
  wheelState: WheelState;
  steerAngle: number;
  thresholds: { cold: number; warm: number; hot: number };
  tempFn: (f: number) => number;
  tempUnit: string;
  onRumble: boolean;
  puddleDepth: number;
  brakeTemp?: number;
}) {
  const clampedAngle = Math.max(-25, Math.min(25, slipAngle));
  const stroke = tireTempColor(temp, thresholds);
  const fill = tireTempColor(temp, thresholds);
  const slipCol = slipAngleColor(slipAngle);
  const wearPct = Math.max(0, Math.min(1, wear));

  // Use canonical wheel state from vehicle-dynamics
  const isLockup = wheelState.state === "lockup";
  const isSpin = wheelState.state === "spin";
  const spinColor = isLockup ? "#ef4444" : isSpin ? "#fb923c" : null;
  const spinLabel = isLockup ? "LOCK" : isSpin ? "SPIN" : null;
  const spinPct = wheelState.slipRatio * 100;

  // Tire dimensions in SVG units
  const tW = 28, tH = 50, cx = 40, cy = 55;
  const wearTop = tH * (1 - wearPct);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 80 145" width={80} height={145}>
        {/* Label */}
        <text x={cx} y={8} textAnchor="middle" fill="#94a3b8" fontSize={8} fontWeight="bold" fontFamily="monospace">{label}</text>

        {/* Spin/Lock glow ring */}
        {spinColor && (
          <rect
            x={cx - tW / 2 - 3} y={cy - tH / 2 - 3}
            width={tW + 6} height={tH + 6}
            rx={8}
            fill="none"
            stroke={spinColor}
            strokeWidth={1.5}
            opacity={0.6}
          >
            <animate attributeName="opacity" values="0.6;0.2;0.6" dur="0.6s" repeatCount="indefinite" />
          </rect>
        )}

        {/* Tire outline — rotates with steering for front wheels */}
        <g transform={steerAngle !== 0 ? `rotate(${Math.max(-20, Math.min(20, steerAngle))}, ${cx}, ${cy})` : undefined}>
          <rect
            x={cx - tW / 2} y={cy - tH / 2}
            width={tW} height={tH}
            rx={6}
            fill="rgba(15,23,42,0.6)"
            stroke={spinColor ?? stroke}
            strokeWidth={2}
          />

          {/* Wear fill (from bottom) */}
          <clipPath id={`wear-${label}`}>
            <rect x={cx - tW / 2 + 1} y={cy - tH / 2 + wearTop} width={tW - 2} height={tH - wearTop} rx={5} />
          </clipPath>
          <rect
            x={cx - tW / 2 + 1} y={cy - tH / 2}
            width={tW - 2} height={tH}
            rx={5}
            fill={fill}
            fillOpacity={0.2}
            clipPath={`url(#wear-${label})`}
          />

          {/* Tread marks */}
          {[-12, -4, 4, 12].map((dy) => (
            <line key={dy} x1={cx - 8} y1={cy + dy} x2={cx + 8} y2={cy + dy} stroke={stroke} strokeWidth={0.5} opacity={0.15} />
          ))}
        </g>

        {/* Slip angle line — only for front wheels where steering makes it meaningful */}
        {steerAngle !== 0 && (
          <g transform={`rotate(${clampedAngle}, ${cx}, ${cy})`}>
            <line x1={cx} y1={cy + tH / 2 - 4} x2={cx} y2={cy - tH / 2 + 4} stroke={slipCol} strokeWidth={1.2} opacity={0.6} />
          </g>
        )}

        {/* Spin/Lock indicators (static, inside tire) */}
        {isSpin && (
          <>
            <polygon points={`${cx},${cy - 18} ${cx - 4},${cy - 12} ${cx + 4},${cy - 12}`} fill={spinColor!} opacity={0.7}>
              <animate attributeName="opacity" values="0.7;0.2;0.7" dur="0.4s" repeatCount="indefinite" />
            </polygon>
            <polygon points={`${cx},${cy + 18} ${cx - 4},${cy + 12} ${cx + 4},${cy + 12}`} fill={spinColor!} opacity={0.7} transform={`rotate(180, ${cx}, ${cy})`}>
              <animate attributeName="opacity" values="0.7;0.2;0.7" dur="0.4s" repeatCount="indefinite" />
            </polygon>
          </>
        )}
        {isLockup && (
          <>
            <line x1={cx - 6} y1={cy - 6} x2={cx + 6} y2={cy + 6} stroke={spinColor!} strokeWidth={2.5} strokeLinecap="round" opacity={0.8}>
              <animate attributeName="opacity" values="0.8;0.3;0.8" dur="0.5s" repeatCount="indefinite" />
            </line>
            <line x1={cx + 6} y1={cy - 6} x2={cx - 6} y2={cy + 6} stroke={spinColor!} strokeWidth={2.5} strokeLinecap="round" opacity={0.8}>
              <animate attributeName="opacity" values="0.8;0.3;0.8" dur="0.5s" repeatCount="indefinite" />
            </line>
          </>
        )}

        {/* Slip angle line — shows direction of slip force */}
        <line
          x1={cx} y1={cy}
          x2={cx + Math.sin(clampedAngle * Math.PI / 180) * 35}
          y2={cy + Math.cos(clampedAngle * Math.PI / 180) * 35}
          stroke={slipCol}
          strokeWidth={1.5}
          strokeDasharray="3 2"
          opacity={0.8}
        />
        <line x1={cx} y1={cy} x2={cx} y2={cy - 35} stroke="rgba(100,116,139,0.2)" strokeWidth={0.8} />

        {/* Slip angle value — outer side */}
        <text
          x={outerSide === "left" ? cx - tW / 2 - 4 : cx + tW / 2 + 4}
          y={cy + 3}
          textAnchor={outerSide === "left" ? "end" : "start"}
          fill={slipCol}
          fontSize={7}
          fontWeight="bold"
          fontFamily="monospace"
        >
          {slipAngle.toFixed(1)}°
        </text>

        {/* Wheel spin % — always visible on outer side */}
        <text
          x={outerSide === "left" ? cx - tW / 2 - 4 : cx + tW / 2 + 4}
          y={cy + 13}
          textAnchor={outerSide === "left" ? "end" : "start"}
          fill={spinColor ?? "#64748b"}
          fontSize={6}
          fontWeight={spinLabel ? "bold" : "normal"}
          fontFamily="monospace"
        >
          {spinLabel ? `${spinLabel} ` : ""}{spinPct > 0 ? "+" : ""}{spinPct.toFixed(0)}%
        </text>

        {/* Below tire: temp, wear, traction */}
        <text x={cx} y={93} textAnchor="middle" fill={stroke} fontSize={9} fontWeight="bold" fontFamily="monospace">
          {tempFn(temp).toFixed(0)}°{tempUnit}
        </text>
        <text x={cx} y={105} textAnchor="middle" fill="#94a3b8" fontSize={9} fontFamily="monospace">
          Health {((1 - wearPct) * 100).toFixed(0)}%
        </text>
        <text x={cx} y={117} textAnchor="middle" fill={tireState(wheelState.state, combined).color} fontSize={8} fontWeight="bold" fontFamily="monospace">
          {tireState(wheelState.state, combined).label}
        </text>

        {/* Brake temp */}
        {brakeTemp != null && brakeTemp > 0 && (
          <text x={cx} y={127} textAnchor="middle" fill={brakeTemp > 600 ? "#ef4444" : brakeTemp > 400 ? "#fb923c" : brakeTemp > 200 ? "#facc15" : "#94a3b8"} fontSize={8} fontFamily="monospace">
            BRK {tempFn(brakeTemp).toFixed(0)}°
          </text>
        )}

        {/* Surface indicators: curb (orange) / puddle (blue) */}
        {onRumble && (
          <text x={cx} y={brakeTemp != null && brakeTemp > 0 ? 137 : 127} textAnchor="middle" fill="#ff8800" fontSize={7} fontWeight="bold" fontFamily="monospace">
            CURB
          </text>
        )}
        {puddleDepth > 0 && (
          <text x={cx} y={(brakeTemp != null && brakeTemp > 0 ? 137 : 127) + (onRumble ? 9 : 0)} textAnchor="middle" fill="#3b82f6" fontSize={7} fontWeight="bold" fontFamily="monospace">
            WET {(puddleDepth * 100).toFixed(0)}%
          </text>
        )}
      </svg>
    </div>
  );
}
