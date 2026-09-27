import { useId } from "react";
import type { WheelState } from "@shared/racing/analysis/laps/physics/vehicle";
import type { TireTemperatureReading } from "../analyse/tire-temperature-profile";
import { brakeTempColor, tireState, tireTempColor } from "@/lib/vehicle-dynamics";
import { m } from "@/paraglide/messages";

/**
 * WheelCard — SVG tire visualization for a single wheel.
 * Surface temperature colors three segments at each tread edge;
 * carcass fills the inner layer, with the core on top when available.
 * Spin/lockup flashes rotate with the steered wheel.
 */
export function WheelCard({
  label,
  temperatureReadings,
  carcassBands,
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
  showWheelState,
  tempCaption,
  healthCaption,
  healthAvailable,
}: {
  label: string;
  temperatureReadings: TireTemperatureReading[];
  carcassBands: readonly [number | null, number | null, number | null];
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
  showWheelState: boolean;
  tempCaption: string;
  healthCaption: string;
  healthAvailable: boolean;
}) {
  const carcassMaskId = useId();
  const surfaceTemp = temperatureReadings.find(({ kind }) => kind === "surface")?.value ?? temperatureReadings.find(({ kind }) => kind === "middle")?.value ?? temperatureReadings.find(({ kind }) => kind === "inner" || kind === "outer")?.value ?? null;
  const carcassTemp = temperatureReadings.find(({ kind }) => kind === "carcass")?.value ?? null;
  const coreTemp = temperatureReadings.find(({ kind }) => kind === "core")?.value ?? null;
  const surfaceBands = temperatureReadings.filter(({ kind }) => kind === "inner" || kind === "middle" || kind === "outer");
  const hasCarcassBands = carcassBands.every((value) => value != null);
  const hasProfile = surfaceBands.length > 0;
  const cardWidth = hasProfile ? 128 : brakeTemp != null ? 140 : 80;
  const wearPct = healthAvailable ? Math.max(0, Math.min(1, wear)) : 0;
  const interiorReadings = temperatureReadings.filter(({ kind }) => kind === "carcass" || kind === "core");
  const tempRows = hasProfile ? 1 + interiorReadings.length : temperatureReadings.length;
  const healthY = 93 + tempRows * 12;
  const stateY = healthY + 12;
  const curbY = onRumble ? stateY + 10 : null;
  const wetY = puddleDepth > 0 ? (curbY ?? stateY) + 9 : null;
  const svgHeight = Math.max(145, (wetY ?? curbY ?? stateY) + 8);

  // Use canonical wheel state from vehicle-dynamics
  const isLockup = showWheelState && wheelState.state === "lockup";
  const isSpin = showWheelState && wheelState.state === "spin";
  const visualState = tireState(wheelState.state, wheelState.slipRatio, (slipAngle * Math.PI) / 180);
  const spinColor = isLockup || isSpin ? visualState.color : null;

  // Tire dimensions in SVG units
  const tW = 34 * 1.2,
    carcassW = tW,
    coreW = 22 * 1.2,
    tH = 60,
    cx = cardWidth === 80 ? cardWidth / 2 : outerSide === "left" ? 44 : cardWidth - 44,
    cy = 55;
  const brakeBarX = outerSide === "left" ? cx + 31 : cx - 39;

  return (
    <div className="flex flex-col items-center">
      <svg role="img" aria-label={`${label} ${temperatureReadings.map(({ kind, value }) => `${kind}: ${value == null ? m.analyse_unavailable() : `${tempFn(value).toFixed(0)}°${tempUnit}`}`).join(", ")}`} viewBox={`0 0 ${cardWidth} ${svgHeight}`} width={cardWidth} height={svgHeight}>
        {/* Tire and flash indicators rotate together with steering */}
        <g transform={steerAngle !== 0 ? `rotate(${Math.max(-20, Math.min(20, steerAngle))}, ${cx}, ${cy})` : undefined}>
          {/* Spin/Lock glow ring */}
          {spinColor && (
            <rect x={cx - tW / 2 - 3} y={cy - tH / 2 - 3} width={tW + 6} height={tH + 6} rx={8} fill="none" stroke={spinColor} strokeWidth={1.5} opacity={0.6}>
              <animate attributeName="opacity" values="0.6;0.2;0.6" dur="0.6s" repeatCount="indefinite" />
            </rect>
          )}
          <rect x={cx - tW / 2} y={cy - tH / 2} width={tW} height={tH} rx={6} fill="var(--app-bg)" fillOpacity={0.6} />
          {[cy - tH / 2, cy + tH / 2 - 6].map((y) => [0, 1, 2].map((index) => {
            const value = hasProfile ? surfaceBands[index]?.value : surfaceTemp;
            const x = cx - tW / 2 + index * (tW / 3);
            const width = tW / 3 - (index < 2 ? 1 : 0);
            const color = value == null ? "var(--status-unavailable)" : tireTempColor(value, thresholds);
            if (index === 1) return <rect key={`${y}-${index}`} x={x} y={y} width={width} height={6} fill={color} />;
            const top = y === cy - tH / 2;
            return <path key={`${y}-${index}`} d={index === 0
              ? top
                ? `M ${x + 6} ${y} H ${x + width} V ${y + 6} H ${x} Q ${x} ${y} ${x + 6} ${y} Z`
                : `M ${x} ${y} H ${x + width} V ${y + 6} H ${x + 6} Q ${x} ${y + 6} ${x} ${y} Z`
              : top
                ? `M ${x} ${y} H ${x + width - 6} Q ${x + width} ${y} ${x + width} ${y + 6} H ${x} Z`
                : `M ${x} ${y} H ${x + width} Q ${x + width} ${y + 6} ${x + width - 6} ${y + 6} H ${x} Z`} fill={color} />;
          }))}
          <mask id={carcassMaskId} maskUnits="userSpaceOnUse" mask-type="alpha" x={cx - carcassW / 2} y={cy - 23} width={carcassW} height={46}>
            <rect x={cx - carcassW / 2} y={cy - 23} width={carcassW} height={46} fill="var(--app-text)" />
            <rect x={cx - coreW / 2} y={cy - 16} width={coreW} height={32} rx={4} fill="var(--app-text)" />
          </mask>
          <g mask={`url(#${carcassMaskId})`}>
            {coreTemp != null && carcassTemp == null && !hasCarcassBands && (
              <rect x={cx - carcassW / 2} y={cy - 23} width={carcassW} height={46} fill="var(--app-surface-alt)" />
            )}
            {hasCarcassBands ? carcassBands.map((value, index) => (
              <rect key={index} x={cx - carcassW / 2 + index * (carcassW / 3)} y={cy - 23} width={carcassW / 3 - (index < 2 ? 1 : 0)} height={46} fill={tireTempColor(value!, thresholds)} />
            )) : carcassTemp != null && (
              <rect x={cx - carcassW / 2} y={cy - 23} width={carcassW} height={46} fill={tireTempColor(carcassTemp, thresholds)} />
            )}
          </g>
          {coreTemp != null && (
            <rect x={cx - coreW / 2} y={cy - 16} width={coreW} height={32} rx={4} fill={tireTempColor(coreTemp, thresholds)} />
          )}

          {/* Spin/Lock indicators inside rotating tire */}
        {isSpin && (
          <g opacity={0.9}>
            <path d={`M ${cx} ${cy - 9} L ${cx + 9} ${cy + 8} H ${cx - 9} Z`} fill={spinColor!} stroke="var(--app-bg)" strokeWidth={1.5} strokeLinejoin="round" />
            <line x1={cx} y1={cy - 2} x2={cx} y2={cy + 2} stroke="var(--app-bg)" strokeWidth={2} strokeLinecap="round" />
            <circle cx={cx} cy={cy + 5} r={1.2} fill="var(--app-bg)" />
            <animate attributeName="opacity" values="0.9;0.4;0.9" dur="0.4s" repeatCount="indefinite" />
          </g>
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
        </g>

        {hasProfile && (
          <>
            <text x={2} y={94} fill="var(--app-text-muted)" fontSize={8} fontFamily="var(--font-mono)">{m.label_surface()}</text>
            {surfaceBands.map(({ kind, value }, index) => (
              <text key={kind} x={54 + index * 30} y={94} textAnchor="middle" fill={value == null ? "var(--status-unavailable)" : tireTempColor(value, thresholds)} fontSize={9} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
                {value == null ? "—" : `${tempFn(value).toFixed(0)}°${tempUnit}`}
              </text>
            ))}
          </>
        )}
        {(hasProfile ? interiorReadings : temperatureReadings).map(({ kind, value }, index) => {
          const labelText = kind === "inner" ? m.label_inner() : kind === "middle" ? m.label_middle() : kind === "outer" ? m.label_outer() : kind === "core" ? m.label_core() : kind === "carcass" ? m.label_carcass() : tempCaption;
          const y = 93 + (hasProfile ? index + 1 : index) * 12;
          const color = value == null ? "var(--status-unavailable)" : tireTempColor(value, thresholds);
          const display = value == null ? "—" : `${tempFn(value).toFixed(0)}°${tempUnit}`;
          return hasProfile ? (
            <g key={kind} fontSize={8} fontFamily="var(--font-mono)">
              <text x={2} y={y} fill="var(--app-text-muted)">{labelText}</text>
              <text x={84} y={y} textAnchor="middle" fill={color} fontWeight="var(--font-weight-bold)">{display}</text>
            </g>
          ) : (
            <text key={kind} x={cx} y={y} textAnchor="middle" fill={color} fontSize={8} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
              {labelText} {display}
            </text>
          );
        })}
        <text x={cx} y={healthY} textAnchor="middle" fill="var(--app-text-muted)" fontSize={8} fontFamily="var(--font-mono)">
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

        {/* Brake disc beside tire, matching live dashboard placement. */}
        {brakeTemp != null && (
          <g fill={brakeTempColor(brakeTemp, label.startsWith("R"))}>
            <rect x={brakeBarX} y={cy - 16} width={7} height={32} />
            <text x={outerSide === "left" ? brakeBarX + 11 : brakeBarX - 4} y={cy + 3} textAnchor={outerSide === "left" ? "start" : "end"} fontSize={8} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
              B:{tempFn(brakeTemp).toFixed(0)}°{tempUnit}
            </text>
          </g>
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
