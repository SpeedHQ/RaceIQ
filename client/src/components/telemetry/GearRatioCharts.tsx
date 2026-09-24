import { useMemo } from "react";
import { GEAR_COLORS } from "../../lib/colors";
import { effectiveGearReady, type EffectiveGears } from "../../lib/gear-ranges";
import type { GearingSample } from "../../lib/gearing-telemetry";
import { ceilTo, findPeakRpm, speedUnitFactor } from "../../lib/gearing-ratios";
import { m } from "../../paraglide/messages";

interface Props {
  packet: GearingSample | null;
  effectiveGears: EffectiveGears;
  powerCurve: { rpm: number; powerW: number }[];
  speedLabel: string;
  /** RPM where the power and torque curves visually cross. */
  crossRpm?: number | null;
}

/**
 * Live effective-gearing chart learned from RPM, road speed, and selected gear.
 * It deliberately models speed-per-RPM rather than entered transmission parts:
 * that is sufficient for redline speed and post-shift RPM without tire size,
 * final drive, or a saved setup.
 */
export function GearRatioCharts({ packet, effectiveGears, powerCurve, speedLabel, crossRpm = null }: Props) {
  const redlineRpm = packet && packet.EngineMaxRpm > 0 ? packet.EngineMaxRpm : 8_000;
  const speedFactor = speedUnitFactor(speedLabel === "mph" ? "mph" : "km/h");
  const peakPowerRpm = useMemo(() => findPeakRpm(powerCurve, "powerW"), [powerCurve]);
  const powerBand = crossRpm != null && peakPowerRpm != null ? { min: Math.min(crossRpm, peakPowerRpm), max: Math.max(crossRpm, peakPowerRpm) } : null;

  const learned = useMemo(
    () =>
      Object.values(effectiveGears)
        .sort((a, b) => a.gear - b.gear)
        .map((gear) => ({
          ...gear,
          ready: effectiveGearReady(gear),
          topSpeed: (redlineRpm / gear.rpmPerMps) * speedFactor,
        })),
    [effectiveGears, redlineRpm, speedFactor],
  );

  const xMax = learned.length > 0 ? ceilTo(Math.max(...learned.map((gear) => gear.topSpeed)) * 1.08, 50) : 0;
  const readyCount = learned.filter((gear) => gear.ready).length;

  return (
    <div className="flex flex-col gap-2 rounded bg-app-surface/40 p-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.grc_learned_title()}</h2>
          <p className="max-w-3xl text-app-caption leading-snug text-app-text-dim">{m.grc_learned_description()}</p>
        </div>
        {learned.length > 0 && <span className="shrink-0 text-app-caption text-app-text-muted">{m.grc_gears_ready({ ready: readyCount, total: learned.length })}</span>}
      </div>

      {learned.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded border border-app-border/50 px-4 text-center">
          <p className="max-w-md text-xs leading-relaxed text-app-text-muted">{m.grc_learning_empty()}</p>
        </div>
      ) : (
        <>
          <GearSpeedChart
            gears={learned.map((gear) => gear.gear)}
            tops={learned.map((gear) => gear.topSpeed)}
            ready={learned.map((gear) => gear.ready)}
            redlineRpm={redlineRpm}
            xMax={xMax}
            band={powerBand}
            speedLabel={speedLabel}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-app-border/60 pt-2">
            {learned.map((gear, index) => {
              const previousTop = index > 0 ? learned[index - 1].topSpeed : null;
              const landingRpm = previousTop == null ? null : redlineRpm * (previousTop / gear.topSpeed);
              return (
                <div key={gear.gear} className="flex items-center gap-1.5 text-app-caption">
                  <span className="font-semibold" style={{ color: GEAR_COLORS[(gear.gear - 1) % GEAR_COLORS.length] }}>
                    {m.dataguide_gear()} {gear.gear}
                  </span>
                  <span className="font-mono text-app-text">
                    {Math.round(gear.topSpeed)} {speedLabel}
                  </span>
                  {landingRpm != null && <span className="text-app-text-dim">· {m.grc_shift_lands({ rpm: Math.round(landingRpm).toLocaleString() })}</span>}
                  <span className={gear.ready ? "text-status-success" : "text-app-text-dim"}>{gear.ready ? m.grc_ready() : m.grc_learning()}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function GearSpeedChart({
  gears,
  tops,
  ready,
  redlineRpm,
  xMax,
  band,
  speedLabel,
}: {
  gears: number[];
  tops: number[];
  ready: boolean[];
  redlineRpm: number;
  xMax: number;
  band: { min: number; max: number } | null;
  speedLabel: string;
}) {
  const width = 640;
  const height = 240;
  const pad = { top: 22, right: 96, bottom: 30, left: 46 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const speedX = (speed: number) => pad.left + Math.min(speed / xMax, 1) * chartWidth;
  const rpmY = (rpm: number) => pad.top + (1 - rpm / redlineRpm) * chartHeight;
  const rpmTicks: number[] = [];
  for (let rpm = 1_000; rpm < redlineRpm; rpm += 1_000) rpmTicks.push(rpm);
  const speedTicks = Array.from({ length: 5 }, (_, index) => Math.round((xMax / 4) * index));

  const lines = gears
    .map((gear, index) => ({ gear, top: tops[index] ?? 0, ready: ready[index] ?? false }))
    .filter((gear) => gear.top > 0)
    .map((gear, index, all) => {
      const previousTop = index === 0 ? 0 : all[index - 1].top;
      return {
        ...gear,
        color: GEAR_COLORS[(gear.gear - 1) % GEAR_COLORS.length],
        startSpeed: previousTop,
        startRpm: index === 0 ? 0 : redlineRpm * (previousTop / gear.top),
      };
    });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded border border-app-border/50" role="img" aria-label={m.grc_learned_chart_label()}>
      {rpmTicks.map((rpm) => (
        <g key={`rpm-${rpm}`}>
          <line x1={pad.left} y1={rpmY(rpm)} x2={pad.left + chartWidth} y2={rpmY(rpm)} stroke="var(--app-border)" strokeWidth={1} />
          <text x={pad.left - 4} y={rpmY(rpm) + 3} textAnchor="end" fontSize={8} fill="var(--app-text-dim)" fontFamily="var(--font-mono)">
            {rpm}
          </text>
        </g>
      ))}

      {speedTicks.map((speed) => (
        <g key={`speed-${speed}`}>
          <line x1={speedX(speed)} y1={pad.top} x2={speedX(speed)} y2={pad.top + chartHeight} stroke="var(--app-border)" strokeWidth={1} />
          <text x={speedX(speed)} y={pad.top + chartHeight + 12} textAnchor="middle" fontSize={8} fill="var(--app-text-dim)" fontFamily="var(--font-mono)">
            {speed}
          </text>
        </g>
      ))}

      <text x={pad.left} y={12} fontSize={8} fill="var(--app-text-muted)">
        rpm
      </text>
      <text x={pad.left + chartWidth} y={height - 6} textAnchor="end" fontSize={8} fill="var(--app-text-muted)">
        {speedLabel}
      </text>

      {band && band.max > band.min && (
        <g>
          <rect x={pad.left} y={rpmY(band.max)} width={chartWidth} height={rpmY(band.min) - rpmY(band.max)} fill="var(--status-warning)" opacity={0.14} />
          <text x={pad.left + chartWidth - 4} y={(rpmY(band.max) + rpmY(band.min)) / 2 + 3} fontSize={8.5} fill="var(--status-warning)" textAnchor="end">
            {m.powerband_legend_power_band()} {Math.round(band.min).toLocaleString()}–{Math.round(band.max).toLocaleString()}
          </text>
        </g>
      )}

      <line x1={pad.left} y1={rpmY(redlineRpm)} x2={pad.left + chartWidth} y2={rpmY(redlineRpm)} stroke="var(--status-danger)" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
      <text x={pad.left + chartWidth + 6} y={rpmY(redlineRpm) + 3} fontSize={8.5} fill="var(--status-danger)">
        {m.powerband_legend_redline()} {Math.round(redlineRpm).toLocaleString()}
      </text>

      {lines.map((line) => (
        <g key={line.gear} opacity={line.ready ? 1 : 0.5}>
          <line
            x1={speedX(line.startSpeed)}
            y1={rpmY(line.startRpm)}
            x2={speedX(line.top)}
            y2={rpmY(redlineRpm)}
            stroke={line.color}
            strokeWidth={1.6}
            strokeDasharray={line.ready ? undefined : "4 3"}
          />
          <text x={speedX(line.top) + 4} y={rpmY(redlineRpm) + 4} fontSize={10} fontWeight="var(--font-weight-bold)" fill={line.color} fontFamily="var(--font-mono)">
            {line.gear}
          </text>
          {line.startRpm > 0 && (
            <text x={speedX(line.startSpeed) - 3} y={rpmY(line.startRpm) - 3} fontSize={7.5} fill={line.color} textAnchor="end" stroke="var(--app-bg)" strokeWidth={3} paintOrder="stroke">
              {Math.round(line.startRpm).toLocaleString()}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
