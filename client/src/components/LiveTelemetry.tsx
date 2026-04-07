import { useEffect, useState, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";
import { tryGetGame } from "@shared/games/registry";
import type { DisplayPacket } from "../lib/convert-packet";
import { SteeringWheel } from "./SteeringWheel";
import { WeightShiftRadar } from "./WeightShiftRadar";
import { useUnits } from "../hooks/useUnits";
import { useSettings } from "../hooks/queries";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";
import { allWheelStates, tireState, tireTempColor, tireTempClass, slipAngleColor, tireHealthTextClass, tireHealthBgClass, type WheelState } from "../lib/vehicle-dynamics";

// Rolling window for grip sparklines — 60s at 10Hz gives a manageable 600-point buffer
const GRIP_HISTORY_SECONDS = 60;
const GRIP_SAMPLE_RATE = 10; // samples per second
const GRIP_MAX_SAMPLES = GRIP_HISTORY_SECONDS * GRIP_SAMPLE_RATE;

/**
 * GripSparkline — Canvas-drawn mini chart showing combined tire slip over time.
 * Y-axis is inverted: 0 (top) = perfect grip, 3 (bottom) = total loss.
 * Color zones provide at-a-glance severity bands (green/yellow/orange/red).
 */
function GripSparkline({ data, label, renderKey, width = 140, height = 40 }: {
  data: number[];
  label: string;
  renderKey: number;
  width?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const maxY = 3;

    // Zone backgrounds (top = 100% grip/green, bottom = 0% loss/red)
    const zones = [
      { from: 0, to: 0.5, color: "rgba(52,211,153,0.08)" },
      { from: 0.5, to: 1.0, color: "rgba(250,204,21,0.08)" },
      { from: 1.0, to: 2.0, color: "rgba(251,146,60,0.06)" },
      { from: 2.0, to: 3.0, color: "rgba(239,68,68,0.06)" },
    ];
    for (const z of zones) {
      const yTop = (z.from / maxY) * height;
      const yBot = (z.to / maxY) * height;
      ctx.fillStyle = z.color;
      ctx.fillRect(0, yTop, width, yBot - yTop);
    }

    // Draw line (inverted: 100% grip at top, 0% at bottom)
    ctx.beginPath();
    const step = width / (GRIP_MAX_SAMPLES - 1);
    const startIdx = GRIP_MAX_SAMPLES - data.length;
    for (let i = 0; i < data.length; i++) {
      const x = (startIdx + i) * step;
      const val = Math.min(data[i], maxY);
      const y = (val / maxY) * height; // high slip = low on chart
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(148,163,184,0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Current value dot
    if (data.length > 0) {
      const last = data[data.length - 1];
      const lx = (startIdx + data.length - 1) * step;
      const ly = (Math.min(last, maxY) / maxY) * height;
      const gripPctVal = Math.max(0, 100 - (last / maxY) * 100);
      const dotColor = gripPctVal > 83 ? "#34d399" : gripPctVal > 67 ? "#facc15" : gripPctVal > 33 ? "#fb923c" : "#ef4444";
      ctx.beginPath();
      ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
    }
  }, [renderKey, width, height]);

  const raw = data.length > 0 ? data[data.length - 1] : 0;
  const gripPct = Math.max(0, Math.round(100 - (raw / 3) * 100));
  const valColor = gripPct > 83 ? "text-emerald-400" : gripPct > 67 ? "text-yellow-400" : gripPct > 33 ? "text-orange-400" : "text-red-400";

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] font-semibold text-app-text-muted uppercase">{label}</span>
      <div className="flex items-center gap-1.5">
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          className="rounded bg-app-surface/40"
        />
        <span className={`text-xs font-mono font-bold tabular-nums ${valColor}`}>
          {gripPct}%
        </span>
      </div>
    </div>
  );
}

/**
 * GripHistory — Manages a per-wheel rolling buffer of combined slip values.
 * Seeds from server history on mount so the chart isn't empty after page refresh.
 * Downsamples 60Hz telemetry to ~10Hz to keep buffer sizes reasonable.
 */
function GripHistory({ packet }: { packet: TelemetryPacket }) {
  const historyRef = useRef<{ fl: number[]; fr: number[]; rl: number[]; rr: number[] }>({
    fl: [], fr: [], rl: [], rr: [],
  });
  const [gripData, setGripData] = useState<{ fl: number[]; fr: number[]; rl: number[]; rr: number[] }>({ fl: [], fr: [], rl: [], rr: [] });
  const [renderKey, setRenderKey] = useState(0);
  const frameRef = useRef(0);
  const fetchedRef = useRef(false);

  // Seed from server on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    client.api["grip-history"].$get()
      .then((r) => r.json() as Promise<{ fl: number[]; fr: number[]; rl: number[]; rr: number[] }>)
      .then((data) => {
        if (data && Array.isArray(data.fl) && data.fl.length > 0) {
          const h = historyRef.current;
          h.fl = data.fl;
          h.fr = data.fr;
          h.rl = data.rl;
          h.rr = data.rr;
          setGripData({ fl: data.fl, fr: data.fr, rl: data.rl, rr: data.rr });
          setRenderKey((v) => v + 1);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const h = historyRef.current;

    // Downsample: only keep every 6th packet (~10 samples/sec from 60Hz)
    frameRef.current++;
    if (frameRef.current % 6 !== 0) return;

    h.fl.push(Math.abs(packet.TireCombinedSlipFL));
    h.fr.push(Math.abs(packet.TireCombinedSlipFR));
    h.rl.push(Math.abs(packet.TireCombinedSlipRL));
    h.rr.push(Math.abs(packet.TireCombinedSlipRR));

    if (h.fl.length > GRIP_MAX_SAMPLES) {
      h.fl.shift(); h.fr.shift(); h.rl.shift(); h.rr.shift();
    }

    setGripData({ fl: h.fl, fr: h.fr, rl: h.rl, rr: h.rr });
    setRenderKey((v) => v + 1);
  }, [packet]);

  return (
    <div className="grid grid-cols-2 gap-2">
      <GripSparkline data={gripData.fl} label="FL" renderKey={renderKey} />
      <GripSparkline data={gripData.fr} label="FR" renderKey={renderKey} />
      <GripSparkline data={gripData.rl} label="RL" renderKey={renderKey} />
      <GripSparkline data={gripData.rr} label="RR" renderKey={renderKey} />
    </div>
  );
}

/**
 * PitEstimate — Tracks fuel burn and tire wear per lap to estimate
 * how many laps remain before needing to pit. Shows whichever
 * runs out first as the pit window.
 */
function PitEstimate({ packet }: { packet: TelemetryPacket }) {
  const gameId = useGameId();
  const { displaySettings } = useSettings();
  const healthThresh = displaySettings.tireHealthThresholds.values;
  const [trackLength, setTrackLength] = useState<number>(0);
  const trackOrdRef = useRef<number>(0);

  // Fetch track length from sector boundaries
  useEffect(() => {
    if (!packet.TrackOrdinal || packet.TrackOrdinal === trackOrdRef.current) return;
    trackOrdRef.current = packet.TrackOrdinal;
    if (!gameId) return;
    client.api["track-sector-boundaries"][":ordinal"].$get({ param: { ordinal: String(packet.TrackOrdinal) }, query: { gameId: gameId! } })
      .then((r) => r.json() as Promise<{ trackLength?: number }>)
      .then((data) => { if (data?.trackLength) setTrackLength(data.trackLength); })
      .catch(() => {});
  }, [packet.TrackOrdinal, gameId]);

  const [pitInitial] = useState(() => ({
    lastWallTime: Date.now() / 1000,
    lastFuel: packet.Fuel,
    lastWorstWear: Math.max(packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR),
    lastDist: packet.DistanceTraveled,
    fuelPerSec: 0,
    wearPerSec: 0,
    avgSpeed: 0,
  }));
  const pitRef = useRef(pitInitial);
  const [pitRates, setPitRates] = useState({ fuelPerSec: 0, wearPerSec: 0, avgSpeed: 0 });

  // Per-second rate tracking (wall clock, smoothed over ~3s)
  useEffect(() => {
    const s = pitRef.current;
    const now = Date.now() / 1000;
    const dt = now - s.lastWallTime;
    if (dt >= 3) {
      const fuelDelta = s.lastFuel - packet.Fuel; // fuel decreases
      const worstWear = Math.max(packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR);
      const wearDelta = worstWear - s.lastWorstWear; // wear increases
      const distDelta = packet.DistanceTraveled - s.lastDist;

      if (fuelDelta > 0) s.fuelPerSec = (fuelDelta / dt) * 100;
      if (wearDelta > 0) s.wearPerSec = (wearDelta / dt) * 100;
      if (distDelta > 0) s.avgSpeed = distDelta / dt; // m/s

      s.lastWallTime = now;
      s.lastFuel = packet.Fuel;
      s.lastWorstWear = worstWear;
      s.lastDist = packet.DistanceTraveled;
      setPitRates({ fuelPerSec: s.fuelPerSec, wearPerSec: s.wearPerSec, avgSpeed: s.avgSpeed });
    }
  }, [packet]);

  // Estimate laps from rate-based calculation:
  // usagePerLap = usagePerSec * (trackLength / avgSpeed)
  // lapsRemaining = currentLevel / usagePerLap
  const canEstimate = pitRates.avgSpeed > 1 && trackLength && trackLength > 100;
  const estLapTime = canEstimate ? trackLength / pitRates.avgSpeed : 0;

  let fuelLaps: number | null = null;
  if (pitRates.fuelPerSec > 0 && canEstimate) {
    const fuelPerLap = (pitRates.fuelPerSec / 100) * estLapTime; // fraction per lap
    if (fuelPerLap > 0) fuelLaps = Math.round((packet.Fuel / fuelPerLap) * 10) / 10;
  }

  // Per-tire calculations
  const tireLabels = ["FL", "FR", "RL", "RR"];
  const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
  const tireData = tireLabels.map((label, i) => {
    const health = (1 - wears[i]) * 100;
    const healthClr = tireHealthTextClass(health, healthThresh);
    const healthBg = tireHealthBgClass(health, healthThresh);
    let laps: number | null = null;
    if (pitRates.wearPerSec > 0 && canEstimate) {
      const wearPerLap = (pitRates.wearPerSec / 100) * estLapTime;
      const remaining = 1 - wears[i];
      if (wearPerLap > 0) laps = Math.round((remaining / wearPerLap) * 10) / 10;
    }
    return { label, health, healthClr, healthBg, laps };
  });

  // Forza: Fuel is 0..1 fraction → percentage. ACC/F1: Fuel is in litres/kg.
  const fuelIsLitres = gameId === "acc" || gameId === "f1-2025";
  const fuelPct = fuelIsLitres ? Math.min(100, packet.Fuel) : (packet.Fuel * 100); // clamp litres for bar width
  const fuelDisplay = fuelIsLitres ? `${packet.Fuel.toFixed(1)}L` : `${fuelPct.toFixed(0)}%`;
  const fuelColor = fuelIsLitres
    ? (packet.Fuel < 5 ? "text-red-400" : packet.Fuel < 15 ? "text-amber-400" : "text-emerald-400")
    : (fuelPct < 20 ? "text-red-400" : fuelPct < 40 ? "text-amber-400" : "text-emerald-400");

  // Pit in = min of fuel laps and worst tire laps
  const worstTireLaps = tireData.reduce<number | null>((min, t) => {
    if (t.laps == null) return min;
    return min == null ? t.laps : Math.min(min, t.laps);
  }, null);
  const hasEstimates = fuelLaps != null || worstTireLaps != null;
  const pitIn = hasEstimates
    ? (fuelLaps != null && worstTireLaps != null ? Math.min(fuelLaps, worstTireLaps) : fuelLaps ?? worstTireLaps!)
    : null;
  const limitedBy = fuelLaps != null && worstTireLaps != null
    ? (fuelLaps <= worstTireLaps ? "fuel" : "tires")
    : fuelLaps != null ? "fuel" : "tires";
  const urgentColor = pitIn != null
    ? (pitIn <= 3 ? "text-red-400" : pitIn <= 6 ? "text-amber-400" : "text-emerald-400")
    : "text-app-text-muted";

  return (
    <div>
      {/* Pit in: limited by + lap count */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-lg font-semibold text-app-text-secondary">
          {hasEstimates ? (
            <>Limited by <span className={`font-bold ${limitedBy === "fuel" ? fuelColor : (tireData.find(t => t.laps === worstTireLaps)?.healthClr ?? "text-app-text")}`}>{limitedBy}</span></>
          ) : (
            <span className="text-app-text-dim">Estimating...</span>
          )}
        </div>
        <span className={`text-3xl font-mono font-black tabular-nums leading-none ${urgentColor}`}>
          {pitIn != null ? (
            <>{pitIn.toFixed(1)} <span className="text-base font-bold">laps</span></>
          ) : (
            <span className="text-app-text-dim">— <span className="text-base font-bold">laps</span></span>
          )}
        </span>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 items-end mb-1 px-1">
        <div />
        <div className="text-[9px] text-app-text-dim uppercase tracking-wider text-center w-14">Level</div>
        <div className="text-[9px] text-app-text-dim uppercase tracking-wider text-center w-16">Est. Laps</div>
        <div className="text-[9px] text-app-text-dim uppercase tracking-wider text-center w-16">Use /5s</div>
      </div>

      <div className="space-y-2">
        {/* Fuel row */}
        <div className="bg-app-surface/50 rounded-md p-2.5">
          <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1.5">Fuel</div>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 items-end">
            <div className="h-2.5 bg-app-surface-alt rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${fuelPct < 20 ? "bg-red-500" : fuelPct < 40 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${fuelPct}%` }} />
            </div>
            <div className={`text-2xl font-mono font-black tabular-nums leading-none text-right ${fuelIsLitres ? "w-20" : "w-14"} ${fuelColor}`}>
              {fuelDisplay}
            </div>
            <div className={`text-2xl font-mono font-black tabular-nums leading-none text-right w-16 ${fuelLaps != null ? fuelColor : "text-app-text-dim"}`}>
              {fuelLaps != null ? `~${fuelLaps.toFixed(1)}` : "—"}
            </div>
            <div className={`text-lg font-mono font-bold tabular-nums leading-none text-right w-16 ${pitRates.fuelPerSec > 0 ? fuelColor : "text-app-text-dim"}`}>
              {pitRates.fuelPerSec > 0 ? (pitRates.fuelPerSec * 5).toFixed(2) : "—"}
            </div>
          </div>
        </div>

        {/* Per-tire health rows */}
        {tireData.map((t) => (
          <div key={t.label} className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-3 items-center px-2.5 py-1.5">
            <div className="text-xs font-bold text-app-text-muted w-5">{t.label}</div>
            <div className="h-2.5 bg-app-surface-alt rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${t.healthBg}`} style={{ width: `${t.health}%` }} />
            </div>
            <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-14 ${t.healthClr}`}>
              {t.health.toFixed(0)}%
            </div>
            <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-16 ${t.laps != null ? t.healthClr : "text-app-text-dim"}`}>
              {t.laps != null ? `~${t.laps.toFixed(1)}` : "—"}
            </div>
            <div className={`text-lg font-mono font-bold tabular-nums leading-none text-right w-16 ${pitRates.wearPerSec > 0 ? t.healthClr : "text-app-text-dim"}`}>
              {pitRates.wearPerSec > 0 ? (pitRates.wearPerSec * 5).toFixed(2) : "—"}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

export type DashboardMode = "driver" | "pitcrew";

interface Props {
  packet: DisplayPacket | null;
  mode?: DashboardMode;
}

export function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}





/**
 * WheelCard — SVG tire visualization for a single wheel.
 * Shows temp (fill color), wear (fill height from bottom), slip angle (tire rotation),
 * combined grip state, and wheel spin/lockup detection.
 * The tire SVG rotates to match the slip angle, with a dashed line showing
 * the angle between tire heading and actual travel direction.
 * Spin/lockup detection uses animated glow rings and X/arrow overlays.
 */
function WheelCard({ label, temp, wear, combined, slipAngle, outerSide, wheelState, steerAngle, thresholds, tempFn, tempUnit, onRumble, puddleDepth, brakeTemp }: {
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

const SUSP_COLORS_BG = ["bg-blue-500", "bg-emerald-400", "bg-yellow-400", "bg-red-500"];

function suspColor(norm: number, thresholds: number[]): string {
  const pct = norm * 100;
  for (let i = 0; i < thresholds.length; i++) {
    if (pct < thresholds[i]) return SUSP_COLORS_BG[i] ?? SUSP_COLORS_BG[0];
  }
  return SUSP_COLORS_BG[thresholds.length] ?? SUSP_COLORS_BG[SUSP_COLORS_BG.length - 1];
}

function SuspBar({ norm, thresholds }: { norm: number; thresholds: number[] }) {
  const pct = Math.min(norm * 100, 100);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-4 h-16 bg-slate-800/80 border border-slate-600/50 rounded-sm overflow-hidden relative">
        <div
          className={`absolute top-0 w-full rounded-sm ${suspColor(norm, thresholds)}`}
          style={{ height: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] font-mono text-app-text-muted tabular-nums w-7 text-center">{pct.toFixed(0)}%</span>
    </div>
  );
}

/**
 * TireDiagram — Arranges 4 WheelCards in a front/rear axle layout with suspension bars.
 * Derives effective wheel radius from ground speed / rotation speed to calculate
 * spin percentage (how much faster/slower each wheel turns vs ground truth).
 * Falls back to 0.33m radius when stationary to avoid division by zero.
 */
export function TireDiagram({ packet }: { packet: DisplayPacket | TelemetryPacket }) {
  const units = useUnits();
  const { displaySettings } = useSettings();
  const suspThresh = displaySettings.suspensionThresholds.values;
  const toDeg = 180 / Math.PI;

  // Use canonical wheel states from vehicle-dynamics (same as LapAnalyse)
  const ws = allWheelStates(packet);

  // Steer: signed int8 (-128 to 127), 0=center. Convert to degrees (~20° max visual lock)
  const steerDeg = (packet.Steer / 127) * 20;

  const wheels = [
    { label: "FL", temp: packet.TireTempFL, wear: packet.TireWearFL, combined: Math.abs(packet.TireCombinedSlipFL), slipAngle: packet.TireSlipAngleFL * toDeg, wheelState: ws.fl, steerAngle: steerDeg, onRumble: packet.WheelOnRumbleStripFL !== 0, puddleDepth: packet.WheelInPuddleDepthFL, brakeTemp: packet.BrakeTempFrontLeft },
    { label: "FR", temp: packet.TireTempFR, wear: packet.TireWearFR, combined: Math.abs(packet.TireCombinedSlipFR), slipAngle: packet.TireSlipAngleFR * toDeg, wheelState: ws.fr, steerAngle: steerDeg, onRumble: packet.WheelOnRumbleStripFR !== 0, puddleDepth: packet.WheelInPuddleDepthFR, brakeTemp: packet.BrakeTempFrontRight },
    { label: "RL", temp: packet.TireTempRL, wear: packet.TireWearRL, combined: Math.abs(packet.TireCombinedSlipRL), slipAngle: packet.TireSlipAngleRL * toDeg, wheelState: ws.rl, steerAngle: 0, onRumble: packet.WheelOnRumbleStripRL !== 0, puddleDepth: packet.WheelInPuddleDepthRL, brakeTemp: packet.BrakeTempRearLeft },
    { label: "RR", temp: packet.TireTempRR, wear: packet.TireWearRR, combined: Math.abs(packet.TireCombinedSlipRR), slipAngle: packet.TireSlipAngleRR * toDeg, wheelState: ws.rr, steerAngle: 0, onRumble: packet.WheelOnRumbleStripRR !== 0, puddleDepth: packet.WheelInPuddleDepthRR, brakeTemp: packet.BrakeTempRearRight },
  ];

  const susp = [
    packet.NormSuspensionTravelFL,
    packet.NormSuspensionTravelFR,
    packet.NormSuspensionTravelRL,
    packet.NormSuspensionTravelRR,
  ];

  return (
    <div className="relative flex flex-col gap-3 w-full max-w-xs mx-auto">
      {/* Front axle */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          <WheelCard {...wheels[0]} outerSide="left" thresholds={units.thresholds} tempFn={units.temp} tempUnit={units.tempUnit} />
          <SuspBar norm={susp[0]} thresholds={suspThresh} />
        </div>
        <div className="flex items-center gap-1">
          <SuspBar norm={susp[1]} thresholds={suspThresh} />
          <WheelCard {...wheels[1]} outerSide="right" thresholds={units.thresholds} tempFn={units.temp} tempUnit={units.tempUnit} />
        </div>
      </div>

      {/* Rear axle */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          <WheelCard {...wheels[2]} outerSide="left" thresholds={units.thresholds} tempFn={units.temp} tempUnit={units.tempUnit} />
          <SuspBar norm={susp[2]} thresholds={suspThresh} />
        </div>
        <div className="flex items-center gap-1">
          <SuspBar norm={susp[3]} thresholds={suspThresh} />
          <WheelCard {...wheels[3]} outerSide="right" thresholds={units.thresholds} tempFn={units.temp} tempUnit={units.tempUnit} />
        </div>
      </div>

      {/* Weight shift radar — absolutely centered between axles */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <WeightShiftRadar packet={packet} />
      </div>
    </div>
  );
}

/**
 * SurfaceConditions — Shows per-wheel curb and puddle status in a compact 2x2 grid.
 * Only renders when at least one wheel is on a curb or in a puddle.
 */
function SurfaceConditions({ packet }: { packet: DisplayPacket | TelemetryPacket }) {
  const wheels = [
    { label: "FL", rumble: packet.WheelOnRumbleStripFL !== 0, puddle: packet.WheelInPuddleDepthFL, surfaceRumble: packet.SurfaceRumbleFL },
    { label: "FR", rumble: packet.WheelOnRumbleStripFR !== 0, puddle: packet.WheelInPuddleDepthFR, surfaceRumble: packet.SurfaceRumbleFR },
    { label: "RL", rumble: packet.WheelOnRumbleStripRL !== 0, puddle: packet.WheelInPuddleDepthRL, surfaceRumble: packet.SurfaceRumbleRL },
    { label: "RR", rumble: packet.WheelOnRumbleStripRR !== 0, puddle: packet.WheelInPuddleDepthRR, surfaceRumble: packet.SurfaceRumbleRR },
  ];

  return (
    <div>
      <div className="text-xs text-app-text-muted uppercase tracking-wider mb-2">Surface</div>
      <div className="grid grid-cols-2 gap-1.5 max-w-[200px] mx-auto">
        {wheels.map(w => (
          <div
            key={w.label}
            className={`flex items-center justify-between px-2 py-1 rounded text-[10px] font-mono border ${
              w.rumble
                ? "border-orange-500/50 bg-orange-950/30"
                : w.puddle > 0
                  ? "border-blue-500/50 bg-blue-950/30"
                  : "border-app-border bg-app-surface-alt/30"
            }`}
          >
            <span className="text-app-text-muted font-bold">{w.label}</span>
            <span className={`font-bold ${w.rumble ? "text-orange-400" : w.puddle > 0 ? "text-blue-400" : "text-app-text-dim"}`}>
              {w.rumble ? "CURB" : w.puddle > 0 ? `WET ${(w.puddle * 100).toFixed(0)}%` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * GForceCircle — Canvas-drawn G-force plot (friction circle).
 * Lateral G on X-axis, longitudinal G on Y-axis. Concentric rings at 0.83G intervals.
 * Raw acceleration (m/s^2) is divided by 9.81 to convert to G units.
 * Dot color indicates total G magnitude.
 */
export function GForceCircle({ packet }: { packet: TelemetryPacket }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = 110;
  const maxG = 2.5;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 8;

    // Background rings
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (r / 3) * i, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(100,116,139,0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.strokeStyle = "rgba(100,116,139,0.1)";
    ctx.stroke();

    // Forza acceleration values are inverted relative to felt G-force:
    // braking produces positive Z, but on a G-meter the dot should go UP (negative canvas Y)
    const latG = -packet.AccelerationX / 9.81;
    const lonG = -packet.AccelerationZ / 9.81;
    const dotX = cx + (latG / maxG) * r;
    const dotY = cy - (lonG / maxG) * r;

    const totalG = Math.sqrt(latG * latG + lonG * lonG);
    const dotColor = totalG < 0.5 ? "#34d399" : totalG < 1.0 ? "#facc15" : totalG < 1.5 ? "#fb923c" : "#ef4444";

    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }, [packet]);

  const latG = -packet.AccelerationX / 9.81;
  const lonG = -packet.AccelerationZ / 9.81;

  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0" style={{ width: size }}>
      <div className="text-[8px] font-mono text-app-text-muted uppercase tracking-wider font-semibold">G-Force</div>
      <canvas ref={canvasRef} style={{ width: size, height: size }} className="rounded bg-app-surface/40" />
      <div className="flex gap-2 text-[8px] font-mono text-app-text-secondary tabular-nums">
        <span className="w-6 text-right">{latG >= 0 ? " " : ""}{latG.toFixed(1)}</span>
        <span className="w-6 text-right">{lonG >= 0 ? " " : ""}{lonG.toFixed(1)}</span>
      </div>
    </div>
  );
}

/**
 * ArcGauge — 270-degree SVG arc gauge (135deg to 405deg sweep).
 * Used for power, torque, and boost readouts. SVG arc path is computed
 * from polar coordinates converted to Cartesian for the arc endpoints.
 */
function ArcGauge({ value, max, label, unit, color }: {
  value: number;
  max: number;
  label: string;
  unit: string;
  color: string;
}) {
  const size = 70;
  const cx = size / 2, cy = size / 2;
  const r = 28;
  const startAngle = 135;
  const endAngle = 405;
  const range = endAngle - startAngle;
  const pct = Math.min(Math.max(value / max, 0), 1);
  const valAngle = startAngle + range * pct;

  const toRad = (d: number) => (d * Math.PI) / 180;
  const arcPath = (from: number, to: number) => {
    const x1 = cx + r * Math.cos(toRad(from));
    const y1 = cy + r * Math.sin(toRad(from));
    const x2 = cx + r * Math.cos(toRad(to));
    const y2 = cy + r * Math.sin(toRad(to));
    const large = to - from > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {/* Background arc */}
        <path d={arcPath(startAngle, endAngle)} fill="none" stroke="rgba(100,116,139,0.15)" strokeWidth={5} strokeLinecap="round" />
        {/* Value arc */}
        {pct > 0.01 && (
          <path d={arcPath(startAngle, valAngle)} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />
        )}
        {/* Value text */}
        <text x={cx} y={cy - 1} textAnchor="middle" fill={color} fontSize={12} fontWeight="bold" fontFamily="monospace">
          {value.toFixed(0)}
        </text>
        {/* Unit */}
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">
          {unit}
        </text>
      </svg>
      <span className="text-[9px] text-app-text-muted -mt-1">{label}</span>
    </div>
  );
}

/**
 * FuelGauge — Tracks fuel consumption per lap to estimate remaining laps.
 * Strategy: records fuel level at each lap start, computes delta on lap boundary,
 * averages last 5 laps for the burn rate estimate. Seeds from server history
 * so estimates survive page refreshes. Filters out impossible values (>100% per lap).
 */
function FuelGauge({ packet }: { packet: TelemetryPacket }) {
  const fuelRef = useRef<{
    lapStart: number;
    lastLap: number;
    history: number[];  // fuel used per lap (all recorded)
    avgPerLap: number | null;
  }>({
    lapStart: packet.Fuel,
    lastLap: packet.LapNumber,
    history: [],
    avgPerLap: null,
  });
  const fetchedRef = useRef(false);
  const [fuelStats, setFuelStats] = useState<{ avgPerLap: number | null; lapStart: number }>({ avgPerLap: null, lapStart: packet.Fuel });

  // Seed from server fuel history
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    client.api["fuel-history"].$get()
      .then((r) => r.json() as Promise<{ fuelUsed: number }[]>)
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const f = fuelRef.current;
          f.history = data.map((d) => d.fuelUsed).filter((v) => v > 0 && v < 1);
          if (f.history.length > 0) {
            const recent = f.history.slice(-5);
            f.avgPerLap = recent.reduce((s, v) => s + v, 0) / recent.length;
            setFuelStats({ avgPerLap: f.avgPerLap, lapStart: f.lapStart });
          }
        }
      })
      .catch(() => {});
  }, []);

  // Track fuel consumption per lap
  useEffect(() => {
    const f = fuelRef.current;
    if (packet.LapNumber !== f.lastLap && packet.LapNumber > f.lastLap) {
      const used = f.lapStart - packet.Fuel;
      if (used > 0 && used < 1) {
        f.history.push(used);
        if (f.history.length > 50) f.history.shift();
        const recent = f.history.slice(-5);
        f.avgPerLap = recent.reduce((s, v) => s + v, 0) / recent.length;
      }
      f.lapStart = packet.Fuel;
      setFuelStats({ avgPerLap: f.avgPerLap, lapStart: f.lapStart });
    }
    f.lastLap = packet.LapNumber;
  }, [packet.LapNumber, packet.Fuel]);

  const fuelIsLitres = packet.gameId === "acc" || packet.gameId === "f1-2025";
  const pct = fuelIsLitres ? Math.min(100, packet.Fuel) : packet.Fuel * 100;
  const fuelLabel = fuelIsLitres ? `${packet.Fuel.toFixed(1)}L` : `${pct.toFixed(0)}%`;
  const fuelColor = fuelIsLitres
    ? (packet.Fuel < 5 ? "bg-red-500" : packet.Fuel < 15 ? "bg-amber-400" : "bg-emerald-400")
    : (pct < 20 ? "bg-red-500" : pct < 40 ? "bg-amber-400" : "bg-emerald-400");
  const textColor = fuelIsLitres
    ? (packet.Fuel < 5 ? "text-red-400" : packet.Fuel < 15 ? "text-amber-400" : "text-emerald-400")
    : (pct < 20 ? "text-red-400" : pct < 40 ? "text-amber-400" : "text-emerald-400");
  const avg = fuelStats.avgPerLap;
  const lapsRemaining = avg && avg > 0 ? Math.floor(packet.Fuel / avg) : null;

  // Current lap fuel used so far
  const currentLapPct = (fuelStats.lapStart - packet.Fuel) * 100;

  // Delta vs average: positive = using more than avg, negative = saving
  return (
    <div className="flex-1">
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className={`font-mono font-bold ${textColor}`}>Fuel {fuelLabel}</span>
        {lapsRemaining != null && (
          <span className="font-mono text-app-text-secondary">
            ~{lapsRemaining} laps left
          </span>
        )}
      </div>
      <div className="h-2 bg-app-surface-alt rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${fuelColor} ${pct < 20 ? "animate-pulse" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      {avg != null && (
        <div className="flex justify-between text-[9px] font-mono mt-0.5">
          <span className="text-app-text-muted">
            {(avg * 100).toFixed(1)}%/lap avg
          </span>
          <span className="text-app-text-muted">
            This lap: {currentLapPct.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}

function PowerTorque({ packet }: { packet: TelemetryPacket }) {
  const hp = packet.Power / 745.7;
  const nm = packet.Torque;
  if (hp <= 0 && nm <= 0) return null;
  const maxHp = 1000;
  const maxNm = 1000;

  return (
    <div className="flex justify-center gap-2">
      <ArcGauge value={hp} max={maxHp} label="Power" unit="hp" color="#fb923c" />
      <ArcGauge value={nm} max={maxNm} label="Torque" unit="Nm" color="#fbbf24" />
    </div>
  );
}



// Consistent color coding across all per-wheel charts: FL=cyan, FR=purple, RL=amber, RR=emerald
const TIRE_COLORS = ["#22d3ee", "#a855f7", "#fbbf24", "#34d399"];
const TIRE_LABELS = ["FL", "FR", "RL", "RR"];

/**
 * FourLineChart — Overlays all 4 tire channels on one canvas (e.g., temp, wear, grip).
 * X-axis is a fixed-width sliding window (GRIP_MAX_SAMPLES); new data enters from the right.
 * Re-renders on a 200ms interval timer rather than per-packet to avoid excessive repaints.
 */
function FourLineChart({ data, label, maxY, unit, height = 50 }: {
  data: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
  label: string;
  maxY?: number;
  unit?: string;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderTick, setRenderTick] = useState(0);

  // Re-render periodically
  useEffect(() => {
    const id = setInterval(() => setRenderTick((v) => v + 1), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const arrays = [data.fl, data.fr, data.rl, data.rr];
    const allVals = arrays.flatMap((a) => a);
    if (allVals.length === 0) return;

    const computedMax = maxY ?? (Math.max(...allVals) * 1.1 || 1);
    const computedMin = maxY != null ? 0 : Math.min(...allVals) * 0.9;
    const yRange = computedMax - computedMin || 1;
    const maxLen = GRIP_MAX_SAMPLES;

    // Y axis: min/max labels
    ctx.font = "7px monospace";
    ctx.fillStyle = "#475569";
    ctx.textAlign = "left";
    ctx.fillText(`${computedMax.toFixed(0)}${unit ?? ""}`, 1, 8);
    ctx.fillText(`${computedMin.toFixed(0)}${unit ?? ""}`, 1, height - 2);

    // Draw each tire line
    for (let t = 0; t < 4; t++) {
      const arr = arrays[t];
      if (arr.length < 2) continue;
      const startIdx = maxLen - arr.length;
      const step = width / (maxLen - 1);

      ctx.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const x = (startIdx + i) * step;
        const y = height - ((arr[i] - computedMin) / yRange) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = TIRE_COLORS[t];
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;

    }
  }, [renderTick, data, maxY, height]);

  void renderTick;
  const arrays = [data.fl, data.fr, data.rl, data.rr];
  const currentVals = arrays.map((a) => a.length > 0 ? a[a.length - 1] : 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] text-app-text-muted font-semibold uppercase">{label}</span>
        <div className="flex gap-2">
          {TIRE_LABELS.map((l, i) => (
            <span key={l} className="text-[8px] font-mono" style={{ color: TIRE_COLORS[i] }}>{l}</span>
          ))}
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-app-surface/40" />
        </div>
        <div className="flex flex-col justify-between w-10 shrink-0" style={{ height }}>
          {TIRE_LABELS.map((l, i) => (
            <span key={l} className="text-[10px] font-mono font-bold tabular-nums text-right" style={{ color: TIRE_COLORS[i] }}>
              {currentVals[i].toFixed(1)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** SingleLineChart — Same sliding-window canvas approach as FourLineChart but for a single metric. */
function SingleLineChart({ data, label, color, maxY, height = 50 }: {
  data: number[];
  label: string;
  color: string;
  maxY?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setRenderTick((v) => v + 1), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || data.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const computedMax = maxY ?? (Math.max(...data) * 1.1 || 1);
    const yRange = computedMax || 1;
    const maxLen = GRIP_MAX_SAMPLES;
    const startIdx = maxLen - data.length;
    const step = width / (maxLen - 1);

    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (startIdx + i) * step;
      const y = height - (data[i] / yRange) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;

  }, [renderTick, data, maxY, height, color]);

  // Force read current value on each tick
  void renderTick;
  const currentVal = data.length > 0 ? data[data.length - 1] : 0;

  return (
    <div>
      <span className="text-[9px] text-app-text-muted font-semibold uppercase">{label}</span>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-app-surface/40" />
        </div>
        <div className="flex items-center w-12 shrink-0">
          <span className="text-[10px] font-mono font-bold tabular-nums text-right w-full" style={{ color }}>{currentVal.toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}

/** DualLineChart — Two overlaid lines sharing one Y-axis (e.g., throttle vs brake trace). */
function DualLineChart({ data1, data2, label1, label2, color1, color2, label, maxY, height = 50 }: {
  data1: number[];
  data2: number[];
  label1: string;
  label2: string;
  color1: string;
  color2: string;
  label: string;
  maxY?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setRenderTick((v) => v + 1), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || data1.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const computedMax = maxY ?? (Math.max(...data1, ...data2) * 1.1 || 1);
    const yRange = computedMax || 1;
    const maxLen = GRIP_MAX_SAMPLES;

    const drawLine = (data: number[], color: string) => {
      const startIdx = maxLen - data.length;
      const step = width / (maxLen - 1);
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = (startIdx + i) * step;
        const y = height - (data[i] / yRange) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.globalAlpha = 1;

    };

    drawLine(data1, color1);
    drawLine(data2, color2);
  }, [renderTick, data1, data2, maxY, height, color1, color2]);

  const val1 = data1.length > 0 ? data1[data1.length - 1] : 0;
  const val2 = data2.length > 0 ? data2[data2.length - 1] : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] text-app-text-muted font-semibold uppercase">{label}</span>
        <div className="flex gap-2">
          <span className="text-[8px] font-mono" style={{ color: color1 }}>{label1}</span>
          <span className="text-[8px] font-mono" style={{ color: color2 }}>{label2}</span>
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-app-surface/40" />
        </div>
        <div className="flex flex-col justify-between w-10 shrink-0" style={{ height }}>
          <span className="text-[10px] font-mono font-bold tabular-nums text-right" style={{ color: color1 }}>{val1.toFixed(0)}</span>
          <span className="text-[10px] font-mono font-bold tabular-nums text-right" style={{ color: color2 }}>{val2.toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * TelemetryCharts — Aggregates all rolling 60s time-series data into chart components.
 * Downsamples from 60Hz to ~10Hz (every 6th frame) to keep buffers at 600 samples.
 * Seeds from server on mount so charts populate immediately after page refresh.
 * Converts raw telemetry units (rad->deg, m/s->mph, 0-255->0-100%) for display.
 */
function TelemetryCharts({ packet }: { packet: DisplayPacket }) {
  const histRef = useRef<{
    grip: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    temp: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    wear: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    slipAngle: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    slipRatio: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    suspension: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    throttle: number[];
    brake: number[];
    speed: number[];
  }>({
    grip: { fl: [], fr: [], rl: [], rr: [] },
    temp: { fl: [], fr: [], rl: [], rr: [] },
    wear: { fl: [], fr: [], rl: [], rr: [] },
    slipAngle: { fl: [], fr: [], rl: [], rr: [] },
    slipRatio: { fl: [], fr: [], rl: [], rr: [] },
    suspension: { fl: [], fr: [], rl: [], rr: [] },
    throttle: [],
    brake: [],
    speed: [],
  });
  const frameRef = useRef(0);
  const fetchedRef = useRef(false);

  // Seed from server
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    client.api["telemetry-history"].$get()
      .then((r) => r.json() as Promise<typeof histRef.current>)
      .then((data) => {
        if (data && Array.isArray(data.grip?.fl)) {
          histRef.current = data;
        }
      })
      .catch(() => {});
  }, []);

  const [chartData, setChartData] = useState({
    grip: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    temp: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    wear: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    slipAngle: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    slipRatio: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    suspension: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    throttle: [] as number[], brake: [] as number[], speed: [] as number[],
  });

  // Sample at ~10Hz
  useEffect(() => {
    frameRef.current++;
    if (frameRef.current % 6 !== 0) return;

    const h = histRef.current;
    const push4 = (t: { fl: number[]; fr: number[]; rl: number[]; rr: number[] }, fl: number, fr: number, rl: number, rr: number) => {
      t.fl.push(fl); t.fr.push(fr); t.rl.push(rl); t.rr.push(rr);
      if (t.fl.length > GRIP_MAX_SAMPLES) { t.fl.shift(); t.fr.shift(); t.rl.shift(); t.rr.shift(); }
    };
    push4(h.grip, Math.abs(packet.TireCombinedSlipFL), Math.abs(packet.TireCombinedSlipFR), Math.abs(packet.TireCombinedSlipRL), Math.abs(packet.TireCombinedSlipRR));
    push4(h.temp, packet.TireTempFL, packet.TireTempFR, packet.TireTempRL, packet.TireTempRR);
    push4(h.wear, packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR);
    push4(h.slipAngle, packet.TireSlipAngleFL * (180 / Math.PI), packet.TireSlipAngleFR * (180 / Math.PI), packet.TireSlipAngleRL * (180 / Math.PI), packet.TireSlipAngleRR * (180 / Math.PI));
    push4(h.slipRatio, Math.abs(packet.TireSlipRatioFL), Math.abs(packet.TireSlipRatioFR), Math.abs(packet.TireSlipRatioRL), Math.abs(packet.TireSlipRatioRR));
    push4(h.suspension, packet.NormSuspensionTravelFL, packet.NormSuspensionTravelFR, packet.NormSuspensionTravelRL, packet.NormSuspensionTravelRR);
    h.throttle.push(packet.Accel / 255 * 100);
    h.brake.push(packet.Brake / 255 * 100);
    h.speed.push(packet.DisplaySpeed);
    if (h.throttle.length > GRIP_MAX_SAMPLES) { h.throttle.shift(); h.brake.shift(); h.speed.shift(); }
    setChartData({ ...h });
  }, [packet]);

  return (
    <div className="grid gap-2">
      <FourLineChart data={chartData.grip} label="Combined Slip" maxY={3} />
      <FourLineChart data={chartData.temp} label="Tire Temp" unit="°" />
      <FourLineChart data={chartData.wear} label="Tire Wear" maxY={1} />
      <FourLineChart data={chartData.slipAngle} label="Slip Angle" unit="°" />
      <FourLineChart data={chartData.slipRatio} label="Slip Ratio" />
      <FourLineChart data={chartData.suspension} label="Suspension" maxY={1} />
      <SingleLineChart data={chartData.speed} label="Speed" color="#22d3ee" />
      <DualLineChart data1={chartData.throttle} data2={chartData.brake} label1="Throttle" label2="Brake" color1="#34d399" color2="#ef4444" label="Throttle / Brake" maxY={100} />
    </div>
  );
}

/**
 * TireRaceView — Compact race-focused tire display.
 * Shows temp, wear %, grip state, and estimates laps remaining based on wear rate.
 */
function TireRaceView({ packet }: { packet: DisplayPacket | TelemetryPacket }) {
  const units = useUnits();
  const { displaySettings } = useSettings();
  const healthThresh = displaySettings.tireHealthThresholds.values;
  const [wearInit] = useState(() => ({
    lastLap: 0,
    wearAtLapStart: [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR],
    wearRates: [] as number[][],
    lastWallTime: Date.now() / 1000,
    lastWear: [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR],
    wearPerSec: [0, 0, 0, 0],
  }));
  const wearRef = useRef(wearInit);
  const [wearState, setWearState] = useState({ wearPerSec: [0, 0, 0, 0], wearRates: [] as number[][] });

  // Track wear per lap for estimates
  useEffect(() => {
    const w = wearRef.current;
    if (packet.LapNumber > w.lastLap && w.lastLap > 0) {
      const currentWear = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
      const deltas = currentWear.map((c, i) => w.wearAtLapStart[i] - c);
      if (deltas.every((d) => d >= 0 && d < 0.5)) {
        w.wearRates.push(deltas);
        if (w.wearRates.length > 10) w.wearRates.shift();
      }
      w.wearAtLapStart = currentWear;
    }
    w.lastLap = packet.LapNumber;
    setWearState({ wearPerSec: w.wearPerSec, wearRates: w.wearRates });
  }, [packet.LapNumber]);

  // Per-second wear rate tracking (wall clock, smoothed over ~3s)
  // TireWear increases as tires degrade (0=new, 1=gone), so delta = current - last
  useEffect(() => {
    const w = wearRef.current;
    const now = Date.now() / 1000;
    const dt = now - w.lastWallTime;
    if (dt >= 3) {
      const currentWear = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
      w.wearPerSec = currentWear.map((c, i) => {
        const delta = c - w.lastWear[i]; // wear increases as tire degrades
        return delta > 0 ? (delta / dt) * 100 : 0;
      });
      w.lastWallTime = now;
      w.lastWear = currentWear;
      setWearState({ wearPerSec: [...w.wearPerSec], wearRates: w.wearRates });
    }
  }, [packet]);

  const tires = [
    { label: "FL", temp: packet.TireTempFL, wear: packet.TireWearFL, grip: Math.abs(packet.TireCombinedSlipFL), wearPerSec: wearState.wearPerSec[0] },
    { label: "FR", temp: packet.TireTempFR, wear: packet.TireWearFR, grip: Math.abs(packet.TireCombinedSlipFR), wearPerSec: wearState.wearPerSec[1] },
    { label: "RL", temp: packet.TireTempRL, wear: packet.TireWearRL, grip: Math.abs(packet.TireCombinedSlipRL), wearPerSec: wearState.wearPerSec[2] },
    { label: "RR", temp: packet.TireTempRR, wear: packet.TireWearRR, grip: Math.abs(packet.TireCombinedSlipRR), wearPerSec: wearState.wearPerSec[3] },
  ];

  // Estimate laps remaining from worst tire
  let lapsEstimate: number | null = null;
  if (wearState.wearRates.length > 0) {
    const avgRates = [0, 1, 2, 3].map((i) => {
      const rates = wearState.wearRates.map((r) => r[i]).filter((r) => r > 0);
      return rates.length > 0 ? rates.reduce((s, v) => s + v, 0) / rates.length : 0;
    });
    const worstIdx = avgRates.indexOf(Math.max(...avgRates));
    if (avgRates[worstIdx] > 0) {
      lapsEstimate = Math.floor(tires[worstIdx].wear / avgRates[worstIdx]);
    }
  }

  return (
    <div>
      {/* 4 tires in 2x2 grid, full width */}
      <div className="grid grid-cols-2 gap-2">
        {tires.map((t) => {
          const healthPct = (1 - t.wear) * 100;
          const healthTxtClr = tireHealthTextClass(healthPct, healthThresh);
          const healthBg = tireHealthBgClass(healthPct, healthThresh);
          const tempDisplay = units.temp(t.temp);
          const tc = tireTempClass(t.temp, units.thresholds);

          return (
            <div key={t.label} className="bg-app-surface-alt/30 rounded-md p-2.5 flex items-center gap-2">
              {/* Vertical health bar */}
              <div className="flex flex-col items-center gap-1 shrink-0">
                <span className="text-xs font-bold text-app-text-muted">{t.label}</span>
                <div className="w-6 bg-app-surface rounded-sm overflow-hidden relative" style={{ height: 50 }}>
                  <div
                    className={`absolute bottom-0 w-full rounded-sm ${healthBg}`}
                    style={{ height: `${healthPct}%` }}
                  />
                </div>
              </div>
              {/* Health % — large */}
              <div className="flex-1 min-w-0">
                <span className={`text-3xl font-mono font-black tabular-nums leading-none ${healthTxtClr}`}>
                  {healthPct.toFixed(0)}%
                </span>
              </div>
              {/* Temp */}
              <div className="flex flex-col items-end shrink-0">
                <span className={`text-xl font-mono font-bold tabular-nums leading-none ${tc}`}>
                  {tempDisplay.toFixed(0)}°
                </span>
                <span className="text-[10px] font-mono text-app-text-dim">{units.tempUnit}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tire summary: lap estimate */}
      <div className="flex items-center justify-end mt-2 px-1">
        {lapsEstimate != null && (
          <span className="text-[10px] font-mono text-app-text-muted">
            ~<span className={`font-bold ${lapsEstimate > 10 ? "text-emerald-400" : lapsEstimate > 5 ? "text-yellow-400" : "text-red-400"}`}>
              {lapsEstimate}
            </span> laps remaining
          </span>
        )}
      </div>
    </div>
  );
}

export function LiveTelemetry({ packet, mode = "driver" }: Props) {
  const gameId = useGameId();
  const [carName, setCarName] = useState<string>("");
  const lastCarOrdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packet) return;
    const ord = packet.CarOrdinal;
    if (ord === lastCarOrdRef.current) return;
    lastCarOrdRef.current = ord;

    client.api["car-name"][":ordinal"].$get({ param: { ordinal: String(ord) }, query: { gameId: gameId! } })
      .then((r) => r.ok ? r.text() : `Car #${ord}`)
      .then((name) => setCarName(name))
      .catch(() => setCarName(`Car #${ord}`));
  }, [packet?.CarOrdinal, gameId]);

  const units = useUnits();

  if (!packet) {
    return (
      <div className="flex items-center justify-center h-full text-app-text-dim">
        Waiting for telemetry data...
      </div>
    );
  }

  const speed = packet.DisplaySpeed;
  const throttlePct = (packet.Accel / 255) * 100;
  const brakePct = (packet.Brake / 255) * 100;
  const rpmPct = packet.EngineMaxRpm > 0 ? (packet.CurrentEngineRpm / packet.EngineMaxRpm) * 100 : 0;
  const hp = packet.Power / 745.7;
  const boostVal = packet.Boost;

  // ── Shared hero: Speed + Gear + RPM ──────────────────────────
  const heroSection = (
    <div className="bg-app-surface-alt/20 p-3 pb-2">
      {carName && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-app-text truncate">{carName}</span>
          <span className="text-[10px] font-mono font-semibold px-1.5 py-px rounded bg-app-surface-alt text-app-accent shrink-0">
            {(gameId && tryGetGame(gameId)?.carClassNames?.[packet.CarClass]) ?? "?"}{packet.CarPerformanceIndex}
          </span>
          <span className="text-[10px] text-app-text-dim shrink-0">
            {(gameId && tryGetGame(gameId)?.drivetrainNames?.[packet.DrivetrainType]) ?? "?"}
          </span>
        </div>
      )}
      <div className="flex items-end justify-between mb-1">
        <div className="flex items-baseline gap-1">
          <span className="text-5xl font-mono font-black text-app-text tabular-nums leading-none tracking-tighter">
            {speed.toFixed(0)}
          </span>
          <span className="text-sm text-app-text-muted font-mono">{units.speedLabel}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] text-app-text-dim font-mono">{hp.toFixed(0)}hp</span>
          <span className={`text-5xl font-mono font-black tabular-nums leading-none tracking-tighter ${rpmPct > 90 ? "text-red-400" : "text-app-accent"}`}>
            {packet.Gear === 0 ? "R" : packet.Gear === 11 ? "N" : packet.Gear}
          </span>
        </div>
      </div>
      <div className="flex gap-[2px] mb-1">
        {Array.from({ length: 30 }, (_, i) => {
          const segPct = ((i + 1) / 30) * 100;
          const lit = rpmPct >= segPct;
          let color: string;
          if (segPct <= 60) color = lit ? "bg-cyan-400" : "bg-cyan-400/8";
          else if (segPct <= 80) color = lit ? "bg-amber-400" : "bg-amber-400/8";
          else color = lit ? "bg-red-500" : "bg-red-500/8";
          return (
            <div key={i} className={`flex-1 h-4 rounded-sm ${color} ${lit && segPct > 90 ? "animate-pulse" : ""}`} />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-app-text-dim font-mono tabular-nums">
        <span>{packet.EngineIdleRpm.toFixed(0)}</span>
        <span>{packet.CurrentEngineRpm.toFixed(0)} rpm</span>
        <span>{packet.EngineMaxRpm.toFixed(0)}</span>
      </div>
    </div>
  );

  // ── DRIVER MODE ──────────────────────────────────────────────
  if (mode === "driver") {
    return (
      <div className="grid gap-0 p-0">
        {/* Tire Health */}
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Tire Health</h2>
          </div>
          <div className="p-3">
            <TireRaceView packet={packet} />
          </div>
        </div>

        {/* Pit Window */}
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Pit Window</h2>
          </div>
          <div className="p-3">
            <PitEstimate packet={packet} />
          </div>
        </div>

      </div>
    );
  }

  // ── PIT CREW MODE ────────────────────────────────────────────
  return (
    <div className="grid gap-0 p-0">
      {heroSection}

      {/* Inputs: Throttle/Brake + Power/Boost */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="flex gap-3 items-center">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-emerald-400 font-bold w-6 text-right tabular-nums">{throttlePct.toFixed(0)}</span>
              <div className="flex-1 h-3 bg-app-surface-alt rounded-full overflow-hidden">
                <div className="h-full bg-emerald-400 rounded-full transition-all" style={{ width: `${throttlePct}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-red-400 font-bold w-6 text-right tabular-nums">{brakePct.toFixed(0)}</span>
              <div className="flex-1 h-3 bg-app-surface-alt rounded-full overflow-hidden">
                <div className="h-full bg-red-500 rounded-full transition-all" style={{ width: `${brakePct}%` }} />
              </div>
            </div>
          </div>
          <div className="flex gap-1 shrink-0">
            <PowerTorque packet={packet} />
            <ArcGauge value={boostVal} max={30} label="Boost" unit="psi" color="#22d3ee" />
          </div>
        </div>
      </div>

      {/* G-Force + Steering + Fuel */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="flex items-center gap-3">
          <GForceCircle packet={packet} />
          <SteeringWheel steer={packet.Steer} />
          <div className="flex-1">
            <FuelGauge packet={packet} />
          </div>
        </div>
      </div>

      {/* Full tire diagram with suspension */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold mb-2">Tires</div>
        <TireDiagram packet={packet} />
      </div>

      {/* Surface conditions */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <SurfaceConditions packet={packet} />
      </div>

      {/* Grip history */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold mb-2">Grip (60s)</div>
        <GripHistory packet={packet} />
      </div>

      {/* Telemetry charts */}
      <div className="px-3 py-2">
        <div className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold mb-2">Telemetry (60s)</div>
        <TelemetryCharts packet={packet} />
      </div>
    </div>
  );
}
