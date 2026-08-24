import type { TuneSettings } from "@shared/racing/tuning/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useUpdateTune, useUserTunes } from "../../hooks/tunes";
import { GEAR_COLORS } from "../../lib/colors";
import type { GearingSample } from "../../lib/gearing-telemetry";
import { ceilTo, findPeakRpm, setupSpeedAtRpm, speedUnitFactor, tireCircumferenceM } from "../../lib/gearing-ratios";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";
import { SearchSelect } from "../ui/SearchSelect";

interface Props {
  packet: GearingSample | null;
  powerCurve: { rpm: number; powerW: number }[];
  /** Car spec top speed in the user's unit (0 = unknown) — fallback V_top and axis bound. */
  targetMaxSpeed: number;
  speedLabel: string;
  /** RPM where the power band's power/torque curves cross (null = unknown). */
  crossRpm?: number | null;
}

interface RatioRow {
  id: number;
  value: number;
}

interface GearingDraft {
  finalDrive: number;
  ratios: RatioRow[];
  /** The setup's top speed in the user's unit (chart anchor). */
  topSpeed: number;
}

interface CarTune {
  id: number;
  name: string;
  settings: TuneSettings;
  gearing: GearingDraft;
}

/** Monotonic ids for ratio rows — stable React keys, never renumbered. */
let nextRatioId = 1;

/** Extract the gearing part of a stored setup; null when the shape doesn't fit. */
function gearingOf(settings: unknown): GearingDraft | null {
  if (!settings || typeof settings !== "object" || !("gearing" in settings)) return null;
  const g = settings.gearing;
  if (!g || typeof g !== "object" || !("finalDrive" in g)) return null;
  const finalDrive = g.finalDrive;
  if (typeof finalDrive !== "number" || !Number.isFinite(finalDrive) || finalDrive <= 0) return null;
  const ratiosRaw = "ratios" in g ? g.ratios : undefined;
  const ratios = Array.isArray(ratiosRaw) ? ratiosRaw.filter((r): r is number => typeof r === "number" && Number.isFinite(r) && r > 0).map((value) => ({ id: nextRatioId++, value })) : [];
  return { finalDrive, ratios, topSpeed: 0 };
}

/**
 * Gear Ratio Chart of the user's setup: loads the current car's tune, shows
 * its gearing (final drive + gear ratios), draws the speed-per-gear sawtooth
 * chart derived from the setup's stored top speed, and saves edits back.
 * The power band range (cross → peak power RPM) and redline come from the
 * live dyno.
 */
export function GearRatioCharts({ packet, powerCurve, targetMaxSpeed, speedLabel, crossRpm = null }: Props) {
  const { data: tunes = [] } = useUserTunes(packet?.gameId);
  const updateTune = useUpdateTune();

  const carTunes = useMemo<CarTune[]>(() => {
    return (tunes as { id: number; name: string; carOrdinal: number; settings: unknown }[])
      .filter((t) => t.carOrdinal === (packet?.CarOrdinal ?? -1))
      .map((t) => ({ id: t.id, name: t.name, settings: t.settings as TuneSettings, gearing: gearingOf(t.settings) }))
      .filter((t): t is CarTune => t.gearing !== null);
  }, [tunes, packet?.CarOrdinal]);
  const setupOptions = useMemo(() => carTunes.map((t) => ({ value: String(t.id), label: t.name })), [carTunes]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<GearingDraft | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const redlineRpm = packet && packet.EngineMaxRpm > 0 ? packet.EngineMaxRpm : 8000;
  const userFactor = speedUnitFactor(speedLabel === "mph" ? "mph" : "km/h");
  // The setup's top speed (user unit): stored topSpeedKph, else car spec.
  const topSpeedOf = useCallback(
    (tune: CarTune): number => {
      const kph = tune.settings.gearing.topSpeedKph;
      const fromTune = kph != null && kph > 0 ? kph * (userFactor / 3.6) : 0;
      return fromTune > 0 ? fromTune : targetMaxSpeed;
    },
    [userFactor, targetMaxSpeed],
  );

  // Auto-select the first tune of the car (and reset when the car changes).
  const activeTune = carTunes.find((t) => t.id === selectedId) ?? null;
  useEffect(() => {
    if (activeTune) return;
    if (carTunes.length > 0) {
      const first = carTunes[0];
      setSelectedId(first.id);
      setDraft({ ...first.gearing, ratios: [...first.gearing.ratios], topSpeed: topSpeedOf(first) });
    } else {
      setSelectedId(null);
      setDraft(null);
    }
  }, [carTunes, activeTune, topSpeedOf]);

  const touchGearing = useCallback((next: GearingDraft) => {
    setDraft(next);
    setSaveStatus("idle");
  }, []);

  const updateFinalDrive = (value: number) => {
    if (!draft) return;
    touchGearing({ ...draft, finalDrive: value });
  };
  const updateTopSpeed = (value: number) => {
    if (!draft) return;
    touchGearing({ ...draft, topSpeed: value });
  };
  const updateRatio = (index: number, value: number) => {
    if (!draft) return;
    touchGearing({ ...draft, ratios: draft.ratios.map((r, i) => (i === index ? { ...r, value } : r)) });
  };
  const addGear = () => {
    if (!draft) return;
    touchGearing({ ...draft, ratios: [...draft.ratios, { id: nextRatioId++, value: 0.5 }] });
  };
  const removeGear = (index: number) => {
    if (!draft) return;
    touchGearing({ ...draft, ratios: draft.ratios.filter((_, i) => i !== index) });
  };
  const selectTune = (id: number) => {
    const tune = carTunes.find((t) => t.id === id);
    if (!tune) return;
    setSelectedId(id);
    touchGearing({ ...tune.gearing, ratios: [...tune.gearing.ratios], topSpeed: topSpeedOf(tune) });
  };

  // ── Chart model ──────────────────────────────────────────────
  const peakPowerRpm = useMemo(() => findPeakRpm(powerCurve, "powerW"), [powerCurve]);

  const chartModel = useMemo(() => {
    if (!draft || draft.ratios.length === 0 || !activeTune) return null;
    // V_top: the setup's top speed (user unit) — the chart's scale anchor.
    const topSpeedUser = draft.topSpeed;
    if (topSpeedUser <= 0) return { noTopSpeed: true as const, tops: [], gears: [], xMax: 0, redlineRpm, topSpeedUser: 0 };
    // Tire circumference is fixed by the SAVED setup (top speed at redline in
    // the saved top gear) so editing the draft FD/ratios rescales the chart
    // instead of silently keeping the stored top speed.
    const savedRatios = activeTune.settings.gearing.ratios;
    const savedTopRatio = savedRatios != null && savedRatios.length > 0 ? savedRatios[savedRatios.length - 1] : 0;
    const circ = tireCircumferenceM(topSpeedUser, savedTopRatio, activeTune.settings.gearing.finalDrive, redlineRpm, userFactor);
    if (circ <= 0) return { noTopSpeed: true as const, tops: [], gears: [], xMax: 0, redlineRpm, topSpeedUser: 0 };
    const gears = draft.ratios.map((_, i) => i + 1).filter((_, i) => draft.ratios[i].value > 0);
    const tops = gears.map((gear) => setupSpeedAtRpm(circ, redlineRpm, draft.ratios[gear - 1].value, draft.finalDrive, userFactor));
    const xMax = ceilTo(Math.max(...tops, topSpeedUser, targetMaxSpeed) * 1.05, 50);
    return { noTopSpeed: false as const, tops, gears, xMax, redlineRpm, topSpeedUser, circ };
  }, [draft, activeTune, redlineRpm, userFactor, targetMaxSpeed]);

  // ── Save ─────────────────────────────────────────────────────
  const save = () => {
    const tune = carTunes.find((t) => t.id === selectedId);
    if (!tune || !draft) return;
    const lastRatio = draft.ratios.length > 0 ? draft.ratios[draft.ratios.length - 1].value : 0;
    // Keep the stored top speed consistent with the saved gearing: recompute
    // the kph top speed from the fixed tire circumference when known.
    const topSpeedKph = chartModel && !chartModel.noTopSpeed && lastRatio > 0 ? setupSpeedAtRpm(chartModel.circ, redlineRpm, lastRatio, draft.finalDrive, 3.6) : tune.settings.gearing.topSpeedKph;
    setSaveStatus("saving");
    updateTune.mutate(
      {
        id: tune.id,
        settings: {
          ...tune.settings,
          gearing: {
            ...tune.settings.gearing,
            finalDrive: draft.finalDrive,
            ratios: draft.ratios.map((r) => r.value),
            ...(topSpeedKph != null ? { topSpeedKph } : {}),
          },
        },
      },
      {
        onSuccess: () => setSaveStatus("saved"),
        onError: () => setSaveStatus("error"),
      },
    );
  };

  const calibrationStatus = saveStatus === "saving" ? m.common_saving() : saveStatus === "saved" ? m.common_saved() : saveStatus === "error" ? m.label_failed_to_save() : "";
  const speedByGear: Record<number, number> = chartModel && !chartModel.noTopSpeed ? Object.fromEntries(chartModel.gears.map((g, i) => [g, chartModel.tops[i]])) : {};

  return (
    <div className="rounded bg-app-surface/40 p-2 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.grc_title()}</h2>
        <div className="flex items-center gap-2">{calibrationStatus && <span className="text-app-caption text-app-text-dim">{calibrationStatus}</span>}</div>
      </div>

      <div className="flex flex-col md:flex-row gap-2">
        {/* Setup panel */}
        <div className="w-full md:w-64 shrink-0 space-y-1.5 rounded border border-app-border p-2">
          {carTunes.length === 0 ? (
            <p className="text-xs text-app-text-muted leading-snug">{m.grc_no_setup()}</p>
          ) : draft ? (
            <>
              <div>
                <div className="text-[9px] font-semibold uppercase tracking-wider text-app-text-muted">{m.aidisplay_setup()}</div>
                <SearchSelect value={selectedId != null ? String(selectedId) : ""} onChange={(value) => selectTune(Number(value))} options={setupOptions} placeholder={m.tune_section_gearing()} />
              </div>

              <label className="flex items-center justify-between gap-2 text-xs">
                <span className="text-app-text-muted whitespace-nowrap">{m.grc_final_drive()}</span>
                <input
                  type="number"
                  step={0.01}
                  min={0.1}
                  value={draft.finalDrive}
                  onChange={(e) => updateFinalDrive(parseFloat(e.target.value) || 0)}
                  className="w-20 bg-app-bg/85 border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
                />
              </label>

              <label className="flex items-center justify-between gap-2 text-xs">
                <span className="text-app-text-muted whitespace-nowrap">
                  {m.tuneform_top_speed()} ({speedLabel})
                </span>
                <input
                  type="number"
                  step={1}
                  min={0}
                  value={draft.topSpeed}
                  onChange={(e) => updateTopSpeed(parseFloat(e.target.value) || 0)}
                  className="w-20 bg-app-bg/85 border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
                />
              </label>

              <div className="pt-1 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-app-text-muted">{m.tuneform_gear_ratios()}</div>
                  <div className="text-[9px] text-app-text-dim">{speedLabel}</div>
                </div>
                {draft.ratios.map((row, index) => (
                  <div key={row.id} className="flex items-center gap-1">
                    <span className="w-9 text-[10px] text-app-text-dim shrink-0">
                      {m.dataguide_gear()} {index + 1}
                    </span>
                    <input
                      type="number"
                      step={0.01}
                      min={0.01}
                      value={row.value}
                      onChange={(e) => updateRatio(index, parseFloat(e.target.value) || 0)}
                      className="flex-1 min-w-0 bg-app-bg/85 border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
                    />
                    <span className="w-12 shrink-0 text-right font-mono text-[10px] text-app-text">{speedByGear[index + 1] != null && row.value > 0 ? Math.round(speedByGear[index + 1]) : "—"}</span>
                    <button
                      type="button"
                      aria-label={`${m.dataguide_gear()} ${index + 1}`}
                      onClick={() => removeGear(index)}
                      className="w-5 h-5 text-xs leading-none rounded text-app-text-muted hover:text-status-danger hover:bg-app-surface-hover"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" onClick={addGear} className="text-app-caption text-app-accent hover:underline">
                  + {m.grc_add_gear()}
                </button>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button size="app-sm" variant="app-primary" onClick={save} disabled={updateTune.isPending}>
                  {m.grc_save_setup()}
                </Button>
              </div>
            </>
          ) : null}
        </div>

        {/* Setup chart */}
        <div className="flex-1 min-w-0">
          {chartModel && !chartModel.noTopSpeed && chartModel.gears.length > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-app-caption text-app-text-dim">
                <span className="font-mono">FD {draft?.finalDrive.toFixed(2)}</span>
                <span className="truncate">
                  {m.tuneform_gear_ratios()}: <span className="font-mono text-app-text">{draft?.ratios.map((r) => r.value.toFixed(2)).join(" / ")}</span>
                </span>
                <span className="shrink-0">
                  {m.tuneform_top_speed()}: <span className="font-mono text-app-text">{Math.round(chartModel.tops[chartModel.tops.length - 1] ?? 0)}</span> {speedLabel}
                </span>
              </div>
              <GearSpeedChart
                gears={chartModel.gears}
                tops={chartModel.tops}
                redlineRpm={chartModel.redlineRpm}
                xMax={chartModel.xMax}
                peakPowerRpm={peakPowerRpm}
                crossRpm={crossRpm}
                speedLabel={speedLabel}
              />
            </div>
          ) : (
            <div className="h-40 flex items-center justify-center rounded border border-app-border/50 px-4 text-center">
              <p className="text-xs text-app-text-muted">{draft && draft.ratios.length === 0 ? m.grc_no_ratios_hint() : m.grc_no_top_speed()}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * SVG sawtooth chart: speed (x) vs RPM (y) for every gear of the setup.
 * Shows the power band range (cross RPM → peak power RPM) and the redline.
 */
function GearSpeedChart({
  gears,
  tops,
  redlineRpm,
  xMax,
  peakPowerRpm,
  crossRpm,
  speedLabel,
}: {
  gears: number[];
  tops: number[];
  redlineRpm: number;
  xMax: number;
  peakPowerRpm: number | null;
  crossRpm: number | null;
  speedLabel: string;
}) {
  const width = 640;
  const height = 240;
  const pad = { top: 22, right: 96, bottom: 30, left: 46 };
  const cW = width - pad.left - pad.right;
  const cH = height - pad.top - pad.bottom;
  const sx = (v: number) => pad.left + Math.min(v / xMax, 1) * cW;
  const sy = (rpm: number) => pad.top + (1 - rpm / redlineRpm) * cH;
  const rpmTicks: number[] = [];
  for (let rpm = 1000; rpm < redlineRpm; rpm += 1000) rpmTicks.push(rpm);
  const speedTicks = Array.from({ length: 5 }, (_, i) => Math.round((xMax / 4) * i));

  // Gear sawtooth: each gear spans from the previous gear's redline speed to
  // its own redline speed (both axes linear in RPM, so lines stay straight).
  const pairs = gears.map((gear, i) => ({ gear, top: tops[i] ?? 0 })).filter((p) => p.top > 0);
  const gearLines = pairs.map((p, i) => {
    const startSpeed = i === 0 ? 0 : pairs[i - 1].top;
    const startRpm = i === 0 ? 0 : redlineRpm * (pairs[i - 1].top / p.top);
    return {
      gear: p.gear,
      color: GEAR_COLORS[(p.gear - 1) % GEAR_COLORS.length],
      x1: sx(startSpeed),
      y1: sy(startRpm),
      x2: sx(p.top),
      y2: sy(redlineRpm),
      startRpm,
    };
  });
  // Power band range: cross RPM → peak power RPM (from the power band chart).
  const bandLo = crossRpm != null && peakPowerRpm != null ? Math.min(crossRpm, peakPowerRpm) : null;
  const bandHi = crossRpm != null && peakPowerRpm != null ? Math.max(crossRpm, peakPowerRpm) : null;
  const refLines: { rpm: number; color: string; label: string }[] = [{ rpm: redlineRpm, color: "var(--status-danger)", label: m.powerband_legend_redline() }];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded border border-app-border/50" role="img" aria-label={`Gear speed chart, redline ${redlineRpm} rpm`}>
      {/* Grid: RPM */}
      {rpmTicks.map((rpm) => (
        <g key={`rpm-${rpm}`}>
          <line x1={pad.left} y1={sy(rpm)} x2={pad.left + cW} y2={sy(rpm)} stroke="var(--app-border)" strokeWidth={1} />
          <text x={pad.left - 4} y={sy(rpm) + 3} textAnchor="end" fontSize={8} fill="var(--app-text-dim)" fontFamily="var(--font-mono)">
            {rpm}
          </text>
        </g>
      ))}

      {/* Grid: speed */}
      {speedTicks.map((speed) => (
        <g key={`speed-${speed}`}>
          <line x1={sx(speed)} y1={pad.top} x2={sx(speed)} y2={pad.top + cH} stroke="var(--app-border)" strokeWidth={1} />
          <text x={sx(speed)} y={pad.top + cH + 12} textAnchor="middle" fontSize={8} fill="var(--app-text-dim)" fontFamily="var(--font-mono)">
            {speed}
          </text>
        </g>
      ))}

      {/* Axis units */}
      <text x={pad.left} y={12} fontSize={8} fill="var(--app-text-muted)">
        rpm
      </text>
      <text x={pad.left + cW} y={height - 6} textAnchor="end" fontSize={8} fill="var(--app-text-muted)">
        {speedLabel}
      </text>

      {/* Power band range: cross RPM → peak power RPM */}
      {bandLo != null && bandHi != null && bandHi > bandLo && (
        <g>
          <rect x={pad.left} y={sy(bandHi)} width={cW} height={sy(bandLo) - sy(bandHi)} fill="var(--status-warning)" opacity={0.14} />
          <text x={pad.left + cW - 4} y={(sy(bandHi) + sy(bandLo)) / 2 + 3} fontSize={8.5} fill="var(--status-warning)" textAnchor="end">
            {m.powerband_legend_power_band()} {Math.round(bandLo).toLocaleString()}–{Math.round(bandHi).toLocaleString()}
          </text>
        </g>
      )}

      {/* Horizontal reference lines: redline */}
      {refLines.map((line) => (
        <g key={line.label}>
          <line x1={pad.left} y1={sy(line.rpm)} x2={pad.left + cW} y2={sy(line.rpm)} stroke={line.color} strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
          <text x={pad.left + cW + 6} y={sy(line.rpm) + 3} fontSize={8.5} fill={line.color}>
            {line.label} {Math.round(line.rpm).toLocaleString()}
          </text>
        </g>
      ))}

      {gearLines.map((line) => (
        <g key={line.gear}>
          <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke={line.color} strokeWidth={1.6} />
          <text x={line.x2 + 4} y={line.y2 + 4} fontSize={10} fontWeight="bold" fill={line.color} fontFamily="var(--font-mono)">
            {line.gear}
          </text>
          {line.startRpm > 0 && (
            <text x={line.x1 - 3} y={line.y1 - 3} fontSize={7.5} fill={line.color} textAnchor="end" stroke="var(--app-bg)" strokeWidth={3} paintOrder="stroke">
              {Math.round(line.startRpm).toLocaleString()}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
