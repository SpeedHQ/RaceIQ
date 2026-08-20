import { Info } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useUnits } from "../../hooks/useUnits";
import type { GearingSample } from "../../lib/gearing-telemetry";
import { findBestShiftRpm, findVisualCrossing } from "../../lib/gearing-ratios";
import { getGearingTelemetryState, resetGearingTelemetry, resetTrackLaps, setAutoRecording, setGearingRecording } from "../../lib/gearing-telemetry";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { GearRatioCharts } from "./GearRatioCharts";
import { PowerBandChart } from "./PowerBandChart";
import { TrackSpeedChart } from "./TrackSpeedChart";

/**
 * Center-radial layout for the Gearing Tuning live dashboard.
 * All child components are game-agnostic so they can be reused for ACC/F1 later.
 *
 * Gearing data accumulates in module-level singletons fed by the ingestion
 * host (LiveTelemetry) on every dashboard mode, so samples survive tab
 * switches and laps driven elsewhere still count. This component only polls
 * the accumulated state at 5 Hz to avoid re-rendering at the full telemetry
 * frame rate.
 */
export function GearingDashboard({ packet, targetMaxSpeed }: { packet: GearingSample; targetMaxSpeed: number }) {
  const units = useUnits();

  // Poll the accumulated state at 5 Hz instead of subscribing to a Zustand store
  const [state, setState] = useState(() => getGearingTelemetryState());
  const stateRef = useRef(state);
  useEffect(() => {
    const id = setInterval(() => {
      const next = getGearingTelemetryState();
      // Skip re-render when nothing changed (e.g. tab idle, no packets).
      if (
        next.buckets === stateRef.current.buckets &&
        next.accelZHistory === stateRef.current.accelZHistory &&
        next.lastValidPacket === stateRef.current.lastValidPacket &&
        next.sessionKey === stateRef.current.sessionKey &&
        next.gearRanges === stateRef.current.gearRanges &&
        next.recording === stateRef.current.recording &&
        next.autoRecording === stateRef.current.autoRecording &&
        next.trackLaps === stateRef.current.trackLaps
      )
        return;
      stateRef.current = next;
      setState(next);
    }, 50);
    return () => clearInterval(id);
  }, []);

  const buckets = state.buckets;
  const trackLaps = state.trackLaps;

  // Aggregate all gears into single overall power and torque curves
  const { powerCurve, torqueCurve } = useMemo(() => {
    const hpByRpm = new Map<number, { sum: number; count: number }>();
    const nmByRpm = new Map<number, { sum: number; count: number }>();

    for (const gearBuckets of Object.values(buckets)) {
      for (const bucket of Object.values(gearBuckets)) {
        const rpm = bucket.rpmMin + 50;
        if (bucket.hpCount > 0) {
          const existing = hpByRpm.get(rpm) ?? { sum: 0, count: 0 };
          existing.sum += bucket.hpSum;
          existing.count += bucket.hpCount;
          hpByRpm.set(rpm, existing);
        }
        if (bucket.nmCount > 0) {
          const existing = nmByRpm.get(rpm) ?? { sum: 0, count: 0 };
          existing.sum += bucket.nmSum;
          existing.count += bucket.nmCount;
          nmByRpm.set(rpm, existing);
        }
      }
    }

    const rawPowerCurve = Array.from(hpByRpm.entries())
      .map(([rpm, { sum, count }]) => ({ rpm, hp: sum / count }))
      .sort((a, b) => a.rpm - b.rpm);

    const rawTorqueCurve = Array.from(nmByRpm.entries())
      .map(([rpm, { sum, count }]) => ({ rpm, nm: sum / count }))
      .sort((a, b) => a.rpm - b.rpm);

    const powerCurve = smoothCurve(rawPowerCurve, "hp", 5);
    const torqueCurve = smoothCurve(rawTorqueCurve, "nm", 5);

    return { powerCurve, torqueCurve };
  }, [buckets]);

  // Best shift point from the overall power curve: first RPM past the peak
  // where power has dropped too much (SHIFT_DROP_RATIO).
  const bestShiftRpm = useMemo(() => findBestShiftRpm(powerCurve), [powerCurve]);

  // RPM where the visually-scaled power and torque curves cross.
  const crossRpm = useMemo(() => {
    if (powerCurve.length < 2 || torqueCurve.length < 2) return null;
    const maxHp = Math.max(...powerCurve.map((p) => p.hp)) * 1.05;
    const maxNm = Math.max(...torqueCurve.map((t) => t.nm)) * 1.05;
    return findVisualCrossing(powerCurve, torqueCurve, maxHp, maxNm);
  }, [powerCurve, torqueCurve]);

  // Help dialog: which chart's instructions are open (null = closed).
  const [helpTopic, setHelpTopic] = useState<"powerband" | "trackspeed" | "gearratio" | null>(null);

  // Power Band help: one entry per legend item and per control, in chart order.
  const powerbandLegend: { label: string; text: string; chip: CSSProperties | null }[] = [
    { label: m.powerband_legend_power(), text: m.gearing_pb_power(), chip: { backgroundColor: "var(--telemetry-power)", width: 12, height: 2 } },
    { label: m.powerband_legend_torque(), text: m.gearing_pb_torque(), chip: { borderTop: "1px dashed var(--telemetry-torque)", width: 12, height: 0 } },
    { label: m.powerband_legend_power_band(), text: m.gearing_pb_band(), chip: { backgroundColor: "var(--status-warning)", width: 12, height: 2 } },
    { label: m.powerband_legend_peak_power(), text: m.gearing_pb_peak_power(), chip: { backgroundColor: "var(--telemetry-power)", width: 8, height: 8, borderRadius: 4 } },
    { label: m.powerband_legend_peak_torque(), text: m.gearing_pb_peak_torque(), chip: { backgroundColor: "var(--telemetry-torque)", width: 8, height: 8, borderRadius: 4 } },
    { label: m.powerband_legend_cross(), text: m.gearing_pb_cross(), chip: { borderTop: "1px dashed var(--app-text)", width: 12, height: 0 } },
    { label: m.powerband_legend_redline(), text: m.gearing_pb_redline(), chip: { borderTop: "1px dashed var(--status-danger)", width: 12, height: 0 } },
    { label: m.powerband_shift(), text: m.gearing_pb_shift(), chip: { borderTop: "1px dashed var(--app-accent)", width: 12, height: 0 } },
  ];
  const powerbandControls: { label: string; text: string }[] = [
    { label: m.powerband_auto(), text: m.gearing_pb_auto() },
    { label: `${m.powerband_record_start()} / ${m.powerband_record_stop()}`, text: m.gearing_pb_start() },
    { label: m.powerband_reset(), text: m.gearing_pb_reset() },
  ];

  return (
    <>
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-2 p-2 h-full overflow-auto">
        {/* Center main chart */}
        <div className="lg:col-span-3 min-h-[300px]">
          <div className="flex justify-end mb-1">
            <Button size="icon-sm" variant="ghost" aria-label={m.gearing_help_button()} onClick={() => setHelpTopic("powerband")}>
              <Info className="size-3.5" />
            </Button>
          </div>
          <PowerBandChart
            packet={packet}
            powerCurve={powerCurve}
            torqueCurve={torqueCurve}
            shiftPointRpm={bestShiftRpm}
            recording={state.recording}
            autoRecording={state.autoRecording}
            onToggleRecording={() => setGearingRecording(!state.recording)}
            onToggleAutoRecording={() => setAutoRecording(!state.autoRecording)}
            onReset={() => {
              resetGearingTelemetry();
              setGearingRecording(false);
            }}
          />
        </div>

        {/* Per-lap track speed trace */}
        <div className="lg:col-span-3">
          <div className="flex justify-end mb-1">
            <Button size="icon-sm" variant="ghost" aria-label={m.gearing_help_button()} onClick={() => setHelpTopic("trackspeed")}>
              <Info className="size-3.5" />
            </Button>
          </div>
          <TrackSpeedChart laps={trackLaps} toDistance={units.distance} distanceLabel={units.distanceLabel} speedLabel={units.speedLabel} onReset={resetTrackLaps} />
        </div>

        {/* User setup gear-ratio chart */}
        <div className="lg:col-span-3">
          <div className="flex justify-end mb-1">
            <Button size="icon-sm" variant="ghost" aria-label={m.gearing_help_button()} onClick={() => setHelpTopic("gearratio")}>
              <Info className="size-3.5" />
            </Button>
          </div>
          <GearRatioCharts packet={packet} powerCurve={powerCurve} targetMaxSpeed={targetMaxSpeed} speedLabel={units.speedLabel} crossRpm={crossRpm} />
        </div>
      </div>
      <Dialog open={helpTopic !== null} onOpenChange={(open) => !open && setHelpTopic(null)}>
        <DialogContent className="sm:max-w-md">
          {helpTopic === "powerband" && (
            <>
              <DialogHeader>
                <DialogTitle>{m.powerband_title()}</DialogTitle>
                <DialogDescription className="text-sm leading-relaxed">{m.gearing_instructions_powerband()}</DialogDescription>
              </DialogHeader>
              <div className="mt-3 space-y-3">
                <div>
                  <div className="text-app-caption font-semibold uppercase tracking-wider text-app-text-muted mb-1.5">{m.gearing_pb_group_legend()}</div>
                  <ul className="space-y-1.5">
                    {powerbandLegend.map((item) => (
                      <li key={item.label} className="flex items-start gap-2 text-sm">
                        <span className="w-3 shrink-0 flex justify-center" style={{ paddingTop: 6 }}>
                          <span style={item.chip ?? undefined} />
                        </span>
                        <span className="shrink-0 font-medium text-app-text min-w-[92px]">{item.label}</span>
                        <span className="text-app-text-muted">{item.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-app-caption font-semibold uppercase tracking-wider text-app-text-muted mb-1.5">{m.gearing_pb_group_buttons()}</div>
                  <ul className="space-y-1.5">
                    {powerbandControls.map((item) => (
                      <li key={item.label} className="flex items-start gap-2 text-sm">
                        <span className="w-3 shrink-0" />
                        <span className="shrink-0 font-medium text-app-text min-w-[92px]">{item.label}</span>
                        <span className="text-app-text-muted">{item.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          )}
          {helpTopic === "trackspeed" && (
            <DialogHeader>
              <DialogTitle>{m.trackspeed_title()}</DialogTitle>
              <ul className="space-y-1.5 text-sm text-app-text-muted list-disc pl-4">
                <li>{m.gearing_ts_step_drive()}</li>
                <li>{m.gearing_ts_step_gears()}</li>
                <li>{m.gearing_ts_step_toggle()}</li>
                <li>{m.gearing_ts_step_hover()}</li>
              </ul>
            </DialogHeader>
          )}
          {helpTopic === "gearratio" && (
            <DialogHeader>
              <DialogTitle>{m.grc_title()}</DialogTitle>
              <ul className="space-y-1.5 text-sm text-app-text-muted list-disc pl-4">
                <li>{m.gearing_gr_step_pick()}</li>
                <li>{m.gearing_gr_step_read()}</li>
                <li>{m.gearing_gr_step_edit()}</li>
                <li>{m.gearing_gr_step_band()}</li>
                <li>{m.gearing_gr_step_save()}</li>
              </ul>
            </DialogHeader>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Simple moving average smoother for bucketed curves */
function smoothCurve<T extends { rpm: number }>(curve: T[], valueKey: keyof T, windowSize: number): T[] {
  if (curve.length < 3) return curve;
  const half = Math.floor(windowSize / 2);
  return curve.map((point, i) => {
    let sum = 0;
    let count = 0;
    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < curve.length) {
        sum += curve[idx][valueKey] as number;
        count++;
      }
    }
    return { ...point, [valueKey]: sum / count } as T;
  });
}
