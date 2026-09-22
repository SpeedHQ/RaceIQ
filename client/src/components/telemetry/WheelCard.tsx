import type { WheelState } from "@shared/racing/analysis/laps/physics/vehicle";
import type { TireTemperatureReading } from "../analyse/tire-temperature-profile";
import { brakeTempColor, slipAngleColor, tireState, tireTempColor } from "@/lib/vehicle-dynamics";
import { m } from "@/paraglide/messages";

/**
 * WheelCard — SVG tire visualization for a single wheel.
 * Shows temp (fill color), wear (fill height from bottom), slip angle (tire rotation),
 * combined grip state, and wheel spin/lockup detection.
 * The tire SVG rotates to match the slip angle, with a dashed line showing
 * the angle between tire heading and actual travel direction.
 * Spin/lockup detection uses animated glow rings and X/arrow overlays.
 */
export function WheelCard({
  label,
  temperatureReadings,
  wear,
  slipAngle,
  outerSide,
  wheelState,
  steerAngle,
  thresholds,
  tempFn,
  tempUnit,
  onRumble,
  puddleDepth,
  brakeTemp,
  showSlipAngle,
  showWheelState,
  tempCaption,
  healthCaption,
  healthAvailable,
}: {
  label: string;
  temperatureReadings: TireTemperatureReading[];
  wear: number;
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
  showSlipAngle: boolean;
  showWheelState: boolean;
  tempCaption: string;
  healthCaption: string;
  healthAvailable: boolean;
}) {
  // Negate for display: physics sign convention is opposite of the visual
  const clampedAngle = -Math.max(-25, Math.min(25, slipAngle));
  const surfaceTemp = temperatureReadings.find(({ kind }) => kind === "surface" || kind === "carcass")?.value ?? temperatureReadings[0]?.value ?? null;
  const coreTemp = temperatureReadings.find(({ kind }) => kind === "core")?.value ?? null;
  const hasCoreTemp = coreTemp != null;
  const hasProfile = temperatureReadings.some(({ kind }) => kind === "inner" || kind === "middle" || kind === "outer");
  const cardWidth = hasProfile ? 112 : 80;
  const stroke = surfaceTemp != null ? tireTempColor(surfaceTemp, thresholds) : "var(--status-unavailable)";
  const fill = hasCoreTemp ? tireTempColor(coreTemp, thresholds) : stroke;
  const slipCol = slipAngleColor(slipAngle);
  const wearPct = healthAvailable ? Math.max(0, Math.min(1, wear)) : 0;
  const tempRows = hasProfile ? 3 : temperatureReadings.length;
  const healthY = 93 + tempRows * 12;
  const stateY = healthY + 12;
  const brakeY = brakeTemp != null ? stateY + 10 : null;
  const curbY = onRumble ? (brakeY ?? stateY) + 10 : null;
  const wetY = puddleDepth > 0 ? (curbY ?? brakeY ?? stateY) + 9 : null;
  const svgHeight = Math.max(145, (wetY ?? curbY ?? brakeY ?? stateY) + 8);

  // Use canonical wheel state from vehicle-dynamics
  const isLockup = showWheelState && wheelState.state === "lockup";
  const isSpin = showWheelState && wheelState.state === "spin";
  const visualState = tireState(wheelState.state, wheelState.slipRatio, (slipAngle * Math.PI) / 180);
  const spinColor = isLockup || isSpin ? visualState.color : null;
  const spinLabel = isLockup ? "LOCK" : isSpin ? "SPIN" : null;
  const spinPct = wheelState.slipRatio * 100;

  // Tire dimensions in SVG units
  const tW = 28,
    tH = 50,
    cx = cardWidth / 2,
    cy = 55;
  const wearTop = tH * (1 - wearPct);

  return (
    <div className="flex flex-col items-center">
      <svg role="img" aria-label={`${label} ${temperatureReadings.map(({ kind, value }) => `${kind}: ${value == null ? m.analyse_unavailable() : `${tempFn(value).toFixed(0)}°${tempUnit}`}`).join(", ")}`} viewBox={`0 0 ${cardWidth} ${svgHeight}`} width={cardWidth} height={svgHeight}>
        {/* Label */}
        <text x={cx} y={8} textAnchor="middle" fill="var(--app-text-muted)" fontSize={8} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
          {label}
        </text>

        {/* Spin/Lock glow ring */}
        {spinColor && (
          <rect x={cx - tW / 2 - 3} y={cy - tH / 2 - 3} width={tW + 6} height={tH + 6} rx={8} fill="none" stroke={spinColor} strokeWidth={1.5} opacity={0.6}>
            <animate attributeName="opacity" values="0.6;0.2;0.6" dur="0.6s" repeatCount="indefinite" />
          </rect>
        )}

        {/* Tire outline — rotates with steering for front wheels */}
        <g transform={steerAngle !== 0 ? `rotate(${Math.max(-20, Math.min(20, steerAngle))}, ${cx}, ${cy})` : undefined}>
          <rect x={cx - tW / 2} y={cy - tH / 2} width={tW} height={tH} rx={6} fill="var(--app-bg)" fillOpacity={0.6} stroke={spinColor ?? stroke} strokeWidth={2} />
          {hasProfile ? temperatureReadings.filter(({ kind }) => kind !== "core").map(({ kind, value }, index) => (
            <rect key={kind} x={cx - tW / 2 + index * (tW / 3)} y={cy - tH / 2 + 1} width={tW / 3 - 1} height={tH - 2} rx={2} fill={value == null ? "var(--status-unavailable)" : tireTempColor(value, thresholds)} fillOpacity={0.6} />
          )) : (
            <>
              <clipPath id={`wear-${label}`}>
                <rect x={cx - tW / 2 + 1} y={cy - tH / 2 + wearTop} width={tW - 2} height={tH - wearTop} rx={5} />
              </clipPath>
              <rect x={cx - tW / 2 + 1} y={cy - tH / 2} width={tW - 2} height={tH} rx={5} fill={fill} fillOpacity={0.2} clipPath={`url(#wear-${label})`} />
            </>
          )}
          {[-12, -4, 4, 12].map((dy) => (
            <line key={dy} x1={cx - 8} y1={cy + dy} x2={cx + 8} y2={cy + dy} stroke={stroke} strokeWidth={0.5} opacity={0.15} />
          ))}
        </g>

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

        {/* Slip angle line — omitted when the source has no per-wheel angle. */}
        {showSlipAngle ? (
          <>
            <line
              x1={cx}
              y1={cy}
              x2={cx + Math.sin((clampedAngle * Math.PI) / 180) * 35}
              y2={cy + Math.cos((clampedAngle * Math.PI) / 180) * 35}
              stroke={slipCol}
              strokeWidth={1.5}
              strokeDasharray="3 2"
              opacity={0.8}
            />
            <line x1={cx} y1={cy} x2={cx} y2={cy - 35} stroke="var(--app-text-dim)" strokeOpacity={0.2} strokeWidth={0.8} />
            <text
              x={outerSide === "left" ? cx - tW / 2 - 4 : cx + tW / 2 + 4}
              y={cy + 3}
              textAnchor={outerSide === "left" ? "end" : "start"}
              fill={slipCol}
              fontSize={7}
              fontWeight="var(--font-weight-bold)"
              fontFamily="var(--font-mono)"
            >
              {slipAngle.toFixed(1)}°
            </text>
          </>
        ) : (
          <text
            x={outerSide === "left" ? cx - tW / 2 - 4 : cx + tW / 2 + 4}
            y={cy + 3}
            textAnchor={outerSide === "left" ? "end" : "start"}
            fill="var(--status-unavailable)"
            fontSize={7}
            fontFamily="var(--font-mono)"
          >
            —
          </text>
        )}

        {/* Wheel spin % — always visible on outer side */}
        <text
          x={outerSide === "left" ? cx - tW / 2 - 4 : cx + tW / 2 + 4}
          y={cy + 13}
          textAnchor={outerSide === "left" ? "end" : "start"}
          fill={spinColor ?? "var(--app-text-dim)"}
          fontSize={6}
          fontWeight={spinLabel ? "var(--font-weight-bold)" : "var(--font-weight-normal)"}
          fontFamily="var(--font-mono)"
        >
        {showWheelState ? (
          <>
            {spinLabel ? `${spinLabel} ` : ""}
            {spinPct > 0 ? "+" : ""}
            {spinPct.toFixed(0)}%
          </>
        ) : "—"}
        </text>
        {hasProfile && temperatureReadings.filter(({ kind }) => kind === "inner" || kind === "middle" || kind === "outer").map(({ kind, value }, index) => {
          const x = (index + 0.5) * (cardWidth / 3);
          const color = value == null ? "var(--status-unavailable)" : tireTempColor(value, thresholds);
          return <g key={kind}>
            <text x={x} y={93} textAnchor="middle" fill="var(--app-text-muted)" fontSize={8} fontFamily="var(--font-mono)">
              {kind === "inner" ? m.label_inner() : kind === "middle" ? m.label_middle() : m.label_outer()}
            </text>
            <text x={x} y={105} textAnchor="middle" fill={color} fontSize={9} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
              {value == null ? "—" : `${tempFn(value).toFixed(0)}°${tempUnit}`}
            </text>
            <line x1={x - 15} x2={x + 15} y1={110} y2={110} stroke={color} strokeWidth={1.5} />
          </g>;
        })}
        {temperatureReadings.filter(({ kind }) => !hasProfile || kind === "core").map(({ kind, value }, index) => {
          const labelText = kind === "inner" ? m.label_inner() : kind === "middle" ? m.label_middle() : kind === "outer" ? m.label_outer() : kind === "core" ? m.label_core() : tempCaption;
          const y = 93 + (hasProfile ? 2 : index) * 12;
          return <text key={kind} x={cx} y={y} textAnchor="middle" fill={value == null ? "var(--status-unavailable)" : tireTempColor(value, thresholds)} fontSize={7} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
            {labelText} {value == null ? "—" : `${tempFn(value).toFixed(0)}°${tempUnit}`}
          </text>;
        })}
        <text x={cx} y={healthY} textAnchor="middle" fill="var(--app-text-muted)" fontSize={7} fontFamily="var(--font-mono)">
          {healthCaption} {healthAvailable ? `${((1 - wearPct) * 100).toFixed(0)}%` : "—"}
        </text>
        {showWheelState ? (
          <text x={cx} y={stateY} textAnchor="middle" fill={visualState.color} fontSize={8} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
            {visualState.label}
          </text>
        ) : (
          <text x={cx} y={stateY} textAnchor="middle" fill="var(--status-unavailable)" fontSize={8} fontFamily="var(--font-mono)">
            —
          </text>
        )}

        {/* Brake temp */}
        {brakeTemp != null && (
          <text x={cx} y={brakeY ?? stateY} textAnchor="middle" fill={brakeTempColor(brakeTemp, label.startsWith("R"))} fontSize={8} fontFamily="var(--font-mono)">
            BRK {tempFn(brakeTemp).toFixed(0)}°{tempUnit}
          </text>
        )}

        {/* Theme-owned curb and puddle surface indicators */}
        {onRumble && (
          <text x={cx} y={curbY ?? stateY} textAnchor="middle" fill="var(--track-curb-right)" fontSize={7} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
            CURB
          </text>
        )}
        {puddleDepth > 0 && (
          <text
            x={cx}
            y={wetY ?? stateY}
            textAnchor="middle"
            fill="var(--surface-wet)"
            fontSize={7}
            fontWeight="var(--font-weight-bold)"
            fontFamily="var(--font-mono)"
          >
            WET {(puddleDepth * 100).toFixed(0)}%
          </text>
        )}
      </svg>
    </div>
  );
}
