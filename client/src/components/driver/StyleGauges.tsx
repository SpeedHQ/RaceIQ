/**
 * Driving-style axes, one calibrated gauge per axis.
 *
 * Deliberately NOT a radar chart. A radar needs every spoke normalised onto a
 * shared 0–1, which would throw away exactly the calibration these numbers have:
 * grip utilisation is measured against the tyres' actual limit (1.0), balance is
 * signed degrees, control loss is a fraction of frames. Flattening them onto one
 * invented scale is how the old uncalibrated "aggression 0–100" axis went wrong.
 * A radar would also have to plot *something* for an axis that came back null,
 * silently turning "not measurable" into zero.
 *
 * So: one row per axis, each carrying its own domain and its own reference
 * marks, and an explicit "not measured" row when the value is null.
 */

import {
  balanceReading,
  brakingStyleReading,
  consistencyReading,
  controlLossReading,
  gripMedianReading,
  gripP95Reading,
  reversalsReading,
  type StyleTone,
  slipVariabilityReading,
} from "@shared/lib/style-readings";
import type { StyleAxes } from "../../../../server/ai/driver-profile-aggregate";

interface Marker {
  at: number;
  label: string;
}

interface GaugeProps {
  label: string;
  /** Null renders the not-measured state rather than a zero. */
  value: number | null;
  /** Formatted value shown to the right of the label. */
  display: string;
  /** Plain-language reading — the part most people will actually read. */
  reading: string;
  min: number;
  max: number;
  markers?: Marker[];
  /** Shaded "normal working range". */
  band?: { from: number; to: number };
  /** Centre the fill on zero rather than filling from the left. */
  bipolar?: boolean;
  tone?: StyleTone;
}

const TONE_FILL: Record<StyleTone, string> = {
  neutral: "bg-status-info",
  good: "bg-status-success",
  warn: "bg-status-warning",
  bad: "bg-status-danger",
};

function pos(v: number, min: number, max: number): number {
  return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
}

function Gauge({ label, value, display, reading, min, max, markers = [], band, bipolar = false, tone = "neutral" }: GaugeProps) {
  if (value === null) {
    return (
      <div className="py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-app-text">{label}</span>
          <span className="text-xs text-app-text-muted italic">not measured</span>
        </div>
        <p className="mt-0.5 text-xs text-app-text-muted">{reading}</p>
      </div>
    );
  }

  const clamped = Math.max(min, Math.min(max, value));
  const zero = pos(0, min, max);
  const p = pos(clamped, min, max);

  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-app-text">{label}</span>
        <span className="text-sm font-medium tabular-nums text-app-text">{display}</span>
      </div>

      <div className="relative mt-1.5 h-2 w-full rounded-full bg-app-text/8">
        {band && <div className="absolute inset-y-0 rounded-full bg-app-text/10" style={{ left: `${pos(band.from, min, max)}%`, width: `${pos(band.to, min, max) - pos(band.from, min, max)}%` }} />}
        {bipolar ? (
          <div className={`absolute inset-y-0 rounded-full ${TONE_FILL[tone]}`} style={{ left: `${Math.min(zero, p)}%`, width: `${Math.abs(p - zero)}%`, minWidth: "2px" }} />
        ) : (
          <div className={`absolute inset-y-0 left-0 rounded-full ${TONE_FILL[tone]}`} style={{ width: `${p}%` }} />
        )}
        {markers.map((mk) => (
          <div key={mk.label} className="absolute -top-0.5 h-3 w-px bg-app-text/50" style={{ left: `${pos(mk.at, min, max)}%` }} />
        ))}
      </div>

      {markers.length > 0 && (
        <div className="relative mt-0.5 h-3">
          {markers.map((mk) => (
            <span key={mk.label} className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-app-text-muted" style={{ left: `${pos(mk.at, min, max)}%` }}>
              {mk.label}
            </span>
          ))}
        </div>
      )}

      <p className="mt-1 text-xs text-app-text-muted">{reading}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function StyleGauges({ style }: { style: StyleAxes }) {
  const gm = style.gripUtilMedian;
  const gp = style.gripUtilP95;
  const bal = style.balanceMedianDeg;
  const cl = style.controlLossFraction;
  const rev = style.steerReversalsPerS;
  const sv = style.slipVariabilityDeg;
  const cons = style.consistency;

  return (
    <div className="divide-y divide-app-text/5">
      <Gauge
        label="Grip usage (median)"
        value={gm}
        display={gm === null ? "" : gm.toFixed(2)}
        reading={gm === null ? "Not enough cornering telemetry to measure." : gripMedianReading(gm).text}
        tone={gm === null ? "neutral" : gripMedianReading(gm).tone}
        min={0}
        max={1.4}
        markers={[{ at: 1.0, label: "limit" }]}
        band={{ from: 0.6, to: 0.85 }}
      />
      <Gauge
        label="Grip usage (peak)"
        value={gp}
        display={gp === null ? "" : gp.toFixed(2)}
        reading={gp === null ? "Not enough cornering telemetry to measure." : gripP95Reading(gp).text}
        tone={gp === null ? "neutral" : gripP95Reading(gp).tone}
        min={0}
        max={1.6}
        markers={[{ at: 1.0, label: "limit" }]}
      />
      <Gauge
        label="Balance"
        value={bal}
        display={bal === null ? "" : `${bal > 0 ? "+" : ""}${bal.toFixed(1)}°`}
        reading={bal === null ? "Not enough cornering telemetry to measure." : balanceReading(bal).text}
        tone={bal === null ? "neutral" : balanceReading(bal).tone}
        min={-8}
        max={8}
        bipolar
        band={{ from: -3, to: 3 }}
        markers={[
          { at: -8, label: "oversteer" },
          { at: 0, label: "neutral" },
          { at: 8, label: "understeer" },
        ]}
      />
      <Gauge
        label="Loss of control"
        value={cl}
        display={cl === null ? "" : `${(cl * 100).toFixed(1)}%`}
        reading={cl === null ? "Not enough cornering telemetry to measure." : controlLossReading(cl).text}
        tone={cl === null ? "neutral" : controlLossReading(cl).tone}
        min={0}
        max={0.25}
        markers={[
          { at: 0.03, label: "normal" },
          { at: 0.1, label: "high" },
        ]}
      />
      <Gauge
        label="Steering variability"
        value={rev}
        display={rev === null ? "" : `${rev.toFixed(1)} /s`}
        reading={rev === null ? "Not enough cornering telemetry to measure." : reversalsReading(rev).text}
        tone={rev === null ? "neutral" : reversalsReading(rev).tone}
        min={0}
        max={5}
        band={{ from: 0.5, to: 2 }}
        markers={[{ at: 3, label: "sawing" }]}
      />
      <Gauge
        label="Attitude stability"
        value={sv}
        display={sv === null ? "" : `${sv.toFixed(1)}°`}
        reading={sv === null ? "Not enough cornering telemetry to measure." : slipVariabilityReading(sv).text}
        tone={sv === null ? "neutral" : slipVariabilityReading(sv).tone}
        min={0}
        max={4}
        band={{ from: 0.5, to: 1.5 }}
        markers={[{ at: 2.5, label: "unsettled" }]}
      />

      {/* Set apart, and captioned: unlike every axis above it, this one has no
          absolute scale. Rendering it in the same column without the caption
          would invite reading -45 as "45% early", which it is not. */}
      <div>
        <Gauge
          label="Braking timing lean"
          value={style.brakingStyle}
          display={`${style.brakingStyle > 0 ? "+" : ""}${style.brakingStyle.toFixed(0)}`}
          reading={brakingStyleReading(style.brakingStyle).text}
          tone={brakingStyleReading(style.brakingStyle).tone}
          min={-100}
          max={100}
          bipolar
          markers={[
            { at: -100, label: "early" },
            { at: 0, label: "neither" },
            { at: 100, label: "late" },
          ]}
        />
        <p className="pb-2 text-[11px] text-app-text-muted/70">
          Relative only — read the sign and the size, not as a percentage. Braking point is a judgement about where you
          <em> should</em> have braked, so unlike the axes above it has no physical scale to measure against.
        </p>
      </div>

      <Gauge
        label="Consistency"
        value={cons}
        display={cons === null ? "" : `${cons.toFixed(0)} / 100`}
        reading={cons === null ? "Needs at least two comparable laps." : consistencyReading(cons).text}
        tone={cons === null ? "neutral" : consistencyReading(cons).tone}
        min={0}
        max={100}
        markers={[{ at: 90, label: "very repeatable" }]}
      />

      <p className="pt-3 text-xs text-app-text-muted">
        Measured across {style.physicsLaps} lap{style.physicsLaps === 1 ? "" : "s"} with usable cornering telemetry.
      </p>
    </div>
  );
}
