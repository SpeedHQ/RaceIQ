import { useEffect, useState, useRef, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";
import { CAR_CLASS_NAMES, DRIVETRAIN_NAMES } from "@shared/types";
import { SteeringWheel } from "./SteeringWheel";
import { convertTemp } from "../lib/temperature";
import { useTelemetry } from "../context/telemetry";

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
      <span className="text-[9px] font-semibold text-slate-500 uppercase">{label}</span>
      <div className="flex items-center gap-1.5">
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          className="rounded bg-slate-900/40"
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
  const [renderKey, setRenderKey] = useState(0);
  const frameRef = useRef(0);
  const fetchedRef = useRef(false);

  // Seed from server on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/grip-history")
      .then((r) => r.json())
      .then((data: { fl: number[]; fr: number[]; rl: number[]; rr: number[] }) => {
        if (data && Array.isArray(data.fl) && data.fl.length > 0) {
          const h = historyRef.current;
          h.fl = data.fl;
          h.fr = data.fr;
          h.rl = data.rl;
          h.rr = data.rr;
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

    setRenderKey((v) => v + 1);
  }, [packet]);

  const h = historyRef.current;

  return (
    <div className="grid grid-cols-2 gap-2">
      <GripSparkline data={h.fl} label="FL" renderKey={renderKey} />
      <GripSparkline data={h.fr} label="FR" renderKey={renderKey} />
      <GripSparkline data={h.rl} label="RL" renderKey={renderKey} />
      <GripSparkline data={h.rr} label="RR" renderKey={renderKey} />
    </div>
  );
}

interface Props {
  packet: TelemetryPacket | null;
}

export function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const mins = Math.floor(seconds);
  const secs = seconds - mins * 60;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function getSpeedMph(p: TelemetryPacket): number {
  return p.Speed * 2.23694; // m/s to mph
}

function GaugeBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// Tire temp thresholds (Fahrenheit): <150 cold, 150-220 optimal, 220-280 hot, >280 overheating
function tempColor(t: number, thresholds: { cold: number; warm: number; hot: number }): string {
  if (t < thresholds.cold) return "text-blue-400";
  if (t < thresholds.warm) return "text-emerald-400";
  if (t < thresholds.hot) return "text-amber-400";
  return "text-red-400";
}

function tempBg(t: number, thresholds: { cold: number; warm: number; hot: number }): string {
  if (t < thresholds.cold) return "bg-blue-500/20 border-blue-500/40";
  if (t < thresholds.warm) return "bg-emerald-500/20 border-emerald-500/40";
  if (t < thresholds.hot) return "bg-amber-500/20 border-amber-500/40";
  return "bg-red-500/20 border-red-500/40";
}

function wearBarColor(w: number): string {
  if (w > 0.75) return "bg-emerald-400";
  if (w > 0.5) return "bg-yellow-400";
  if (w > 0.25) return "bg-orange-400";
  return "bg-red-500";
}

// Combined slip thresholds: <0.5 = grip, 0.5-1.0 = sliding, 1.0-2.0 = slipping, >2.0 = total loss
function gripColor(combined: number): string {
  if (combined < 0.5) return "text-emerald-400";
  if (combined < 1.0) return "text-yellow-400";
  if (combined < 2.0) return "text-orange-400";
  return "text-red-400";
}

function gripLabel(combined: number): string {
  if (combined < 0.5) return "GRIP";
  if (combined < 1.0) return "SLIDE";
  if (combined < 2.0) return "SLIP";
  return "LOSS";
}

function gripPulse(combined: number): string {
  if (combined >= 2.0) return "animate-pulse";
  return "";
}

function tireColor(t: number, thresholds: { cold: number; warm: number; hot: number }): string {
  if (t < thresholds.cold) return "#3b82f6";
  if (t < thresholds.warm) return "#34d399";
  if (t < thresholds.hot) return "#f59e0b";
  return "#ef4444";
}

function slipLineColor(deg: number): string {
  const a = Math.abs(deg);
  if (a < 4) return "#34d399";
  if (a < 8) return "#facc15";
  if (a < 14) return "#fb923c";
  return "#ef4444";
}

/**
 * WheelCard — SVG tire visualization for a single wheel.
 * Shows temp (fill color), wear (fill height from bottom), slip angle (tire rotation),
 * combined grip state, and wheel spin/lockup detection.
 * The tire SVG rotates to match the slip angle, with a dashed line showing
 * the angle between tire heading and actual travel direction.
 * Spin/lockup detection uses animated glow rings and X/arrow overlays.
 */
function WheelCard({ label, temp, wear, combined, slipAngle, outerSide, spinPct, steerAngle, thresholds, temperatureUnit }: {
  label: string;
  temp: number;
  wear: number;
  combined: number;
  slipAngle: number;
  outerSide: "left" | "right";
  spinPct: number;
  steerAngle: number;
  thresholds: { cold: number; warm: number; hot: number };
  temperatureUnit: "F" | "C";
}) {
  const clampedAngle = Math.max(-25, Math.min(25, slipAngle));
  const stroke = tireColor(temp, thresholds);
  const fill = tireColor(temp, thresholds);
  const slipCol = slipLineColor(slipAngle);
  const wearPct = Math.max(0, Math.min(1, wear));

  // Adjust thresholds based on steering — in turns, inner wheels are naturally slower
  const steerFactor = Math.abs(steerAngle) / 20; // 0-1 based on steering lock
  const lockThreshold = -(8 + steerFactor * 15); // -8% straight, up to -23% in hard turn
  const spinThreshold = 8 + steerFactor * 10; // 8% straight, up to 18% in hard turn
  const isLockup = spinPct < lockThreshold;
  const isSpin = spinPct > spinThreshold;
  const spinColor = isLockup ? "#ef4444" : isSpin ? "#fb923c" : null;
  const spinLabel = isLockup ? "LOCK" : isSpin ? "SPIN" : null;

  // Tire dimensions in SVG units
  const tW = 28, tH = 50, cx = 40, cy = 55;
  const wearTop = tH * (1 - wearPct);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 80 130" width={80} height={130}>
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
          {convertTemp(temp, temperatureUnit).toFixed(0)}°{temperatureUnit}
        </text>
        <text x={cx} y={105} textAnchor="middle" fill="#94a3b8" fontSize={7} fontFamily="monospace">
          Wear {(wearPct * 100).toFixed(0)}%
        </text>
        <text x={cx} y={117} textAnchor="middle" fill={combined < 0.5 ? "#34d399" : combined < 1.0 ? "#facc15" : combined < 2.0 ? "#fb923c" : "#ef4444"} fontSize={8} fontWeight="bold" fontFamily="monospace">
          {gripLabel(combined)}
        </text>
      </svg>
    </div>
  );
}

function suspColor(norm: number): string {
  if (norm < 0.6) return "bg-cyan-400";
  if (norm < 0.85) return "bg-yellow-400";
  return "bg-red-500";
}

function SuspBar({ norm }: { norm: number }) {
  const pct = Math.min(norm * 100, 100);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-4 h-16 bg-slate-900/60 rounded-sm overflow-hidden relative">
        <div
          className={`absolute bottom-0 w-full rounded-sm transition-all ${suspColor(norm)}`}
          style={{ height: `${pct}%` }}
        />
      </div>
      <span className="text-[8px] font-mono text-slate-500">{pct.toFixed(0)}%</span>
    </div>
  );
}

/**
 * TireDiagram — Arranges 4 WheelCards in a front/rear axle layout with suspension bars.
 * Derives effective wheel radius from ground speed / rotation speed to calculate
 * spin percentage (how much faster/slower each wheel turns vs ground truth).
 * Falls back to 0.33m radius when stationary to avoid division by zero.
 */
export function TireDiagram({ packet }: { packet: TelemetryPacket }) {
  const { tempSettings } = useTelemetry();
  const toDeg = 180 / Math.PI;
  const gs = packet.Speed;

  // Derive effective wheel radius from the average of all wheels when driving straight
  // wheelSpeed = rotSpeed * radius => radius = groundSpeed / rotSpeed
  const rotSpeeds = [
    Math.abs(packet.WheelRotationSpeedFL),
    Math.abs(packet.WheelRotationSpeedFR),
    Math.abs(packet.WheelRotationSpeedRL),
    Math.abs(packet.WheelRotationSpeedRR),
  ];
  const avgRot = (rotSpeeds[0] + rotSpeeds[1] + rotSpeeds[2] + rotSpeeds[3]) / 4;
  // Use derived radius, fallback to 0.33 if stationary
  const effectiveRadius = avgRot > 5 && gs > 3 ? gs / avgRot : 0.33;

  const spinPct = (rotSpeed: number) => {
    const wheelSpeed = Math.abs(rotSpeed) * effectiveRadius;
    return gs > 3 ? ((wheelSpeed - gs) / gs) * 100 : 0;
  };

  // Steer: signed int8 (-128 to 127), 0=center. Convert to degrees (~20° max visual lock)
  const steerDeg = (packet.Steer / 127) * 20;

  const wheels = [
    { label: "FL", temp: packet.TireTempFL, wear: packet.TireWearFL, combined: Math.abs(packet.TireCombinedSlipFL), slipAngle: packet.TireSlipAngleFL * toDeg, spinPct: spinPct(packet.WheelRotationSpeedFL), steerAngle: steerDeg },
    { label: "FR", temp: packet.TireTempFR, wear: packet.TireWearFR, combined: Math.abs(packet.TireCombinedSlipFR), slipAngle: packet.TireSlipAngleFR * toDeg, spinPct: spinPct(packet.WheelRotationSpeedFR), steerAngle: steerDeg },
    { label: "RL", temp: packet.TireTempRL, wear: packet.TireWearRL, combined: Math.abs(packet.TireCombinedSlipRL), slipAngle: packet.TireSlipAngleRL * toDeg, spinPct: spinPct(packet.WheelRotationSpeedRL), steerAngle: 0 },
    { label: "RR", temp: packet.TireTempRR, wear: packet.TireWearRR, combined: Math.abs(packet.TireCombinedSlipRR), slipAngle: packet.TireSlipAngleRR * toDeg, spinPct: spinPct(packet.WheelRotationSpeedRR), steerAngle: 0 },
  ];

  const susp = [
    packet.NormSuspensionTravelFL,
    packet.NormSuspensionTravelFR,
    packet.NormSuspensionTravelRL,
    packet.NormSuspensionTravelRR,
  ];

  return (
    <div className="grid grid-cols-[80px_auto_80px] gap-x-3 gap-y-3 items-center justify-center mx-auto" style={{ maxWidth: 280 }}>
      {/* Front axle */}
      <WheelCard {...wheels[0]} outerSide="left" thresholds={tempSettings.tireTemperatureThresholds} temperatureUnit={tempSettings.temperatureUnit} />
      <div className="flex gap-2">
        <SuspBar norm={susp[0]} />
        <SuspBar norm={susp[1]} />
      </div>
      <WheelCard {...wheels[1]} outerSide="right" thresholds={tempSettings.tireTemperatureThresholds} temperatureUnit={tempSettings.temperatureUnit} />

      {/* Divider */}
      <div className="col-span-3 h-px bg-slate-700/30" />

      {/* Rear axle */}
      <WheelCard {...wheels[2]} outerSide="left" thresholds={tempSettings.tireTemperatureThresholds} temperatureUnit={tempSettings.temperatureUnit} />
      <div className="flex gap-2">
        <SuspBar norm={susp[2]} />
        <SuspBar norm={susp[3]} />
      </div>
      <WheelCard {...wheels[3]} outerSide="right" thresholds={tempSettings.tireTemperatureThresholds} temperatureUnit={tempSettings.temperatureUnit} />
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
      <canvas ref={canvasRef} style={{ width: size, height: size }} className="rounded bg-slate-900/40" />
      <div className="flex gap-2 text-[8px] font-mono text-slate-400 tabular-nums">
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
      <span className="text-[9px] text-slate-500 -mt-1">{label}</span>
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

  // Seed from server fuel history
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/fuel-history")
      .then((r) => r.json())
      .then((data: { fuelUsed: number }[]) => {
        if (Array.isArray(data) && data.length > 0) {
          const f = fuelRef.current;
          f.history = data.map((d) => d.fuelUsed).filter((v) => v > 0 && v < 1);
          if (f.history.length > 0) {
            const recent = f.history.slice(-5);
            f.avgPerLap = recent.reduce((s, v) => s + v, 0) / recent.length;
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
        // Recalculate average from last 5 laps
        const recent = f.history.slice(-5);
        f.avgPerLap = recent.reduce((s, v) => s + v, 0) / recent.length;
      }
      f.lapStart = packet.Fuel;
    }
    f.lastLap = packet.LapNumber;
  }, [packet.LapNumber, packet.Fuel]);

  const pct = packet.Fuel * 100;
  const fuelColor = pct < 20 ? "bg-red-500" : pct < 40 ? "bg-amber-400" : "bg-emerald-400";
  const textColor = pct < 20 ? "text-red-400" : pct < 40 ? "text-amber-400" : "text-emerald-400";
  const avg = fuelRef.current.avgPerLap;
  const lapsRemaining = avg && avg > 0 ? Math.floor(packet.Fuel / avg) : null;

  // Current lap fuel used so far
  const currentLapUsed = fuelRef.current.lapStart - packet.Fuel;
  const currentLapPct = currentLapUsed * 100;

  // Delta vs average: positive = using more than avg, negative = saving
  const delta = avg ? currentLapUsed - (avg * (packet.CurrentLap > 0 ? 1 : 0)) : null;

  return (
    <div className="flex-1">
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className={`font-mono font-bold ${textColor}`}>Fuel {pct.toFixed(0)}%</span>
        {lapsRemaining != null && (
          <span className="font-mono text-slate-400">
            ~{lapsRemaining} laps left
          </span>
        )}
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${fuelColor} ${pct < 20 ? "animate-pulse" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      {avg != null && (
        <div className="flex justify-between text-[9px] font-mono mt-0.5">
          <span className="text-slate-500">
            {(avg * 100).toFixed(1)}%/lap avg
          </span>
          <span className="text-slate-500">
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
  const maxHp = 1000;
  const maxNm = 1000;

  return (
    <div className="flex justify-center gap-2">
      <ArcGauge value={hp} max={maxHp} label="Power" unit="hp" color="#fb923c" />
      <ArcGauge value={nm} max={maxNm} label="Torque" unit="Nm" color="#fbbf24" />
    </div>
  );
}

function WheelSpin({ packet }: { packet: TelemetryPacket }) {
  const groundSpeed = packet.Speed; // m/s
  const wheelRadius = 0.33; // ~avg tire radius in meters

  const wheels = [
    { label: "FL", rpm: packet.WheelRotationSpeedFL },
    { label: "FR", rpm: packet.WheelRotationSpeedFR },
    { label: "RL", rpm: packet.WheelRotationSpeedRL },
    { label: "RR", rpm: packet.WheelRotationSpeedRR },
  ];

  return (
    <div className="grid grid-cols-4 gap-1.5">
      {wheels.map((w) => {
        const wheelSpeed = Math.abs(w.rpm) * wheelRadius;
        const diff = groundSpeed > 1 ? ((wheelSpeed - groundSpeed) / groundSpeed) * 100 : 0;
        const isLockup = diff < -10;
        const isSpin = diff > 10;
        const color = isLockup ? "text-red-400" : isSpin ? "text-orange-400" : "text-slate-400";
        const stateLabel = isLockup ? "LOCK" : isSpin ? "SPIN" : "";

        return (
          <div key={w.label} className="bg-slate-800/50 rounded px-1.5 py-1 text-center">
            <div className="text-[9px] text-slate-500 font-semibold">{w.label}</div>
            <div className={`text-xs font-mono font-bold tabular-nums ${color}`}>
              {diff.toFixed(0)}%
            </div>
            {stateLabel && (
              <div className={`text-[8px] font-bold ${color} animate-pulse`}>{stateLabel}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function angleStrokeColor(deg: number): string {
  const a = Math.abs(deg);
  if (a < 4) return "#34d399";
  if (a < 8) return "#facc15";
  if (a < 14) return "#fb923c";
  return "#ef4444";
}

function angleFillColor(deg: number): string {
  const a = Math.abs(deg);
  if (a < 4) return "text-emerald-400";
  if (a < 8) return "text-yellow-400";
  if (a < 14) return "text-orange-400";
  return "text-red-400";
}

function SlipAngles({ packet }: { packet: TelemetryPacket }) {
  const toDeg = 180 / Math.PI;
  const angles = [
    { label: "FL", value: packet.TireSlipAngleFL * toDeg, x: 22, y: 18 },
    { label: "FR", value: packet.TireSlipAngleFR * toDeg, x: 78, y: 18 },
    { label: "RL", value: packet.TireSlipAngleRL * toDeg, x: 22, y: 82 },
    { label: "RR", value: packet.TireSlipAngleRR * toDeg, x: 78, y: 82 },
  ];

  // Clamp rotation for visual (max ±20° display)
  const clampAngle = (d: number) => Math.max(-20, Math.min(20, d));

  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 100 100" width={160} height={160} className="drop-shadow">
        {/* Car body */}
        <rect x={34} y={10} width={32} height={80} rx={8} fill="none" stroke="rgba(100,116,139,0.25)" strokeWidth={1} />
        {/* Axle lines */}
        <line x1={22} y1={18} x2={78} y2={18} stroke="rgba(100,116,139,0.15)" strokeWidth={0.5} />
        <line x1={22} y1={82} x2={78} y2={82} stroke="rgba(100,116,139,0.15)" strokeWidth={0.5} />

        {/* Tires as rotated rectangles */}
        {angles.map((a) => (
          <g key={a.label} transform={`translate(${a.x}, ${a.y})`}>
            {/* Direction indicator line */}
            <line
              x1={0} y1={0} x2={0} y2={-14}
              stroke={angleStrokeColor(a.value)}
              strokeWidth={0.8}
              opacity={0.5}
              transform={`rotate(${clampAngle(a.value)})`}
            />
            {/* Tire rectangle */}
            <rect
              x={-5} y={-9} width={10} height={18} rx={2}
              fill={angleStrokeColor(a.value)}
              fillOpacity={0.25}
              stroke={angleStrokeColor(a.value)}
              strokeWidth={1}
              transform={`rotate(${clampAngle(a.value)})`}
            />
            {/* Value label */}
            <text
              y={a.y < 50 ? -14 : 20}
              textAnchor="middle"
              fill={angleStrokeColor(a.value)}
              fontSize={6}
              fontFamily="monospace"
              fontWeight="bold"
            >
              {a.value.toFixed(1)}°
            </text>
          </g>
        ))}

        {/* Front arrow (direction of travel) */}
        <polygon points="50,2 47,7 53,7" fill="rgba(100,116,139,0.3)" />
      </svg>
    </div>
  );
}

/**
 * BodyAttitude — Three SVG mini-views showing car orientation:
 * 1. Rear view: car body rotates with roll angle (weight transfer in corners)
 * 2. Side view: car body rotates with pitch angle (braking/acceleration dive)
 * 3. Compass: arrow rotates with yaw heading
 * All angles converted from radians to degrees, clamped for visual sanity.
 */
function BodyAttitude({ packet }: { packet: TelemetryPacket }) {
  const toDeg = 180 / Math.PI;
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
          {/* Horizon line */}
          <line x1={5} y1={25} x2={65} y2={25} stroke="rgba(100,116,139,0.15)" strokeWidth={0.5} />
          {/* Car body — rotates with roll */}
          <g transform={`rotate(${clampRoll}, 35, 30)`}>
            {/* Body */}
            <rect x={15} y={22} width={40} height={14} rx={3} fill="none" stroke="rgba(34,211,238,0.5)" strokeWidth={1.5} />
            {/* Roof */}
            <path d="M22 22 L25 14 L45 14 L48 22" fill="none" stroke="rgba(34,211,238,0.5)" strokeWidth={1.5} />
            {/* Wheels */}
            <rect x={11} y={32} width={8} height={5} rx={1.5} fill="rgba(34,211,238,0.3)" stroke="rgba(34,211,238,0.5)" strokeWidth={1} />
            <rect x={51} y={32} width={8} height={5} rx={1.5} fill="rgba(34,211,238,0.3)" stroke="rgba(34,211,238,0.5)" strokeWidth={1} />
          </g>
          <text x={35} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">Roll {roll.toFixed(1)}°</text>
        </svg>
      </div>

      {/* Side view — shows pitch */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 70 50" width={70} height={50}>
          {/* Horizon */}
          <line x1={5} y1={25} x2={65} y2={25} stroke="rgba(100,116,139,0.15)" strokeWidth={0.5} />
          {/* Car body — rotates with pitch */}
          <g transform={`rotate(${-clampPitch}, 35, 28)`}>
            {/* Body */}
            <rect x={10} y={20} width={50} height={12} rx={3} fill="none" stroke="rgba(251,191,36,0.5)" strokeWidth={1.5} />
            {/* Windshield */}
            <path d="M42 20 L48 12 L55 12 L55 20" fill="none" stroke="rgba(251,191,36,0.5)" strokeWidth={1.5} />
            {/* Wheels */}
            <circle cx={20} cy={34} r={4} fill="rgba(251,191,36,0.3)" stroke="rgba(251,191,36,0.5)" strokeWidth={1} />
            <circle cx={50} cy={34} r={4} fill="rgba(251,191,36,0.3)" stroke="rgba(251,191,36,0.5)" strokeWidth={1} />
          </g>
          <text x={35} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">Pitch {pitch.toFixed(1)}°</text>
        </svg>
      </div>

      {/* Yaw value */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 40 50" width={40} height={50}>
          {/* Compass circle */}
          <circle cx={20} cy={22} r={14} fill="none" stroke="rgba(100,116,139,0.2)" strokeWidth={0.8} />
          {/* Direction arrow */}
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

  const _ = renderTick;
  const arrays = [data.fl, data.fr, data.rl, data.rr];
  const currentVals = arrays.map((a) => a.length > 0 ? a[a.length - 1] : 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] text-slate-500 font-semibold uppercase">{label}</span>
        <div className="flex gap-2">
          {TIRE_LABELS.map((l, i) => (
            <span key={l} className="text-[8px] font-mono" style={{ color: TIRE_COLORS[i] }}>{l}</span>
          ))}
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-slate-900/40" />
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
function SingleLineChart({ data, label, color, maxY, unit, height = 50 }: {
  data: number[];
  label: string;
  color: string;
  maxY?: number;
  unit?: string;
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
  const _ = renderTick;
  const currentVal = data.length > 0 ? data[data.length - 1] : 0;

  return (
    <div>
      <span className="text-[9px] text-slate-500 font-semibold uppercase">{label}</span>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-slate-900/40" />
        </div>
        <div className="flex items-center w-12 shrink-0">
          <span className="text-[10px] font-mono font-bold tabular-nums text-right w-full" style={{ color }}>{currentVal.toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}

/** DualLineChart — Two overlaid lines sharing one Y-axis (e.g., throttle vs brake trace). */
function DualLineChart({ data1, data2, label1, label2, color1, color2, label, maxY, unit, height = 50 }: {
  data1: number[];
  data2: number[];
  label1: string;
  label2: string;
  color1: string;
  color2: string;
  label: string;
  maxY?: number;
  unit?: string;
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
        <span className="text-[9px] text-slate-500 font-semibold uppercase">{label}</span>
        <div className="flex gap-2">
          <span className="text-[8px] font-mono" style={{ color: color1 }}>{label1}</span>
          <span className="text-[8px] font-mono" style={{ color: color2 }}>{label2}</span>
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-slate-900/40" />
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
function TelemetryCharts({ packet }: { packet: TelemetryPacket }) {
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
    fetch("/api/telemetry-history")
      .then((r) => r.json())
      .then((data: any) => {
        if (data && Array.isArray(data.grip?.fl)) {
          histRef.current = data;
        }
      })
      .catch(() => {});
  }, []);

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
    h.speed.push(packet.Speed * 2.23694);
    if (h.throttle.length > GRIP_MAX_SAMPLES) { h.throttle.shift(); h.brake.shift(); h.speed.shift(); }
  }, [packet]);

  const h = histRef.current;

  return (
    <div className="grid gap-2">
      <FourLineChart data={h.grip} label="Combined Slip" maxY={3} />
      <FourLineChart data={h.temp} label="Tire Temp" unit="°" />
      <FourLineChart data={h.wear} label="Tire Wear" maxY={1} />
      <FourLineChart data={h.slipAngle} label="Slip Angle" unit="°" />
      <FourLineChart data={h.slipRatio} label="Slip Ratio" />
      <FourLineChart data={h.suspension} label="Suspension" maxY={1} />
      <SingleLineChart data={h.speed} label="Speed" color="#22d3ee" unit="mph" />
      <DualLineChart data1={h.throttle} data2={h.brake} label1="Throttle" label2="Brake" color1="#34d399" color2="#ef4444" label="Throttle / Brake" maxY={100} unit="%" />
    </div>
  );
}

export function LiveTelemetry({ packet }: Props) {
  const [carName, setCarName] = useState<string>("");
  const lastCarOrdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packet) return;
    const ord = packet.CarOrdinal;
    if (ord === lastCarOrdRef.current) return;
    lastCarOrdRef.current = ord;

    fetch(`/api/car-name/${ord}`)
      .then((r) => r.text())
      .then((name) => setCarName(name))
      .catch(() => setCarName(`Car #${ord}`));
  }, [packet?.CarOrdinal]);

  if (!packet) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600">
        Waiting for telemetry data...
      </div>
    );
  }

  const speed = getSpeedMph(packet);
  const throttlePct = (packet.Accel / 255) * 100;
  const brakePct = (packet.Brake / 255) * 100;
  const rpmPct = packet.EngineMaxRpm > 0 ? (packet.CurrentEngineRpm / packet.EngineMaxRpm) * 100 : 0;

  return (
    <div className="grid gap-2 p-3">
      {/* Row 1: Car + Speed + Gear */}
      <div className="flex items-center gap-3">
        {carName && (
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white truncate">{carName}</div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono font-semibold px-1 py-px rounded bg-slate-800 text-cyan-400">
                {CAR_CLASS_NAMES[packet.CarClass] ?? "?"} {packet.CarPerformanceIndex}
              </span>
              <span className="text-[10px] text-slate-500">
                {DRIVETRAIN_NAMES[packet.DrivetrainType] ?? "?"} &middot; {packet.NumCylinders}cyl
              </span>
            </div>
          </div>
        )}
        <div className="text-right">
          <div className="text-3xl font-mono font-bold text-white tabular-nums leading-none">
            {speed.toFixed(0)} <span className="text-xs text-slate-500">mph</span>
          </div>
        </div>
        <div className="text-3xl font-mono font-bold text-cyan-400 tabular-nums leading-none">
          {packet.Gear === 0 ? "R" : packet.Gear === 11 ? "N" : packet.Gear}
        </div>
      </div>

      {/* Row 2: RPM segments */}
      <div className="flex justify-between text-[10px] text-slate-500 font-mono">
        <span>RPM</span>
        <span>{packet.CurrentEngineRpm.toFixed(0)} / {packet.EngineMaxRpm.toFixed(0)}</span>
      </div>
      <div className="flex gap-[2px] -mt-0.5">
        {Array.from({ length: 20 }, (_, i) => {
          const segPct = ((i + 1) / 20) * 100;
          const lit = rpmPct >= segPct;
          let color: string;
          if (segPct <= 60) color = lit ? "bg-cyan-400" : "bg-cyan-400/10";
          else if (segPct <= 80) color = lit ? "bg-amber-400" : "bg-amber-400/10";
          else color = lit ? "bg-red-500" : "bg-red-500/10";
          return (
            <div
              key={i}
              className={`flex-1 h-3 rounded-sm transition-colors ${color} ${lit && segPct > 90 ? "animate-pulse" : ""}`}
            />
          );
        })}
      </div>

      {/* Row 3: Throttle/Brake pedals + Fuel + Steering + G-Force */}
      <div className="flex items-center gap-3">
        {/* Pedal bars — vertical, fill from bottom */}
        <div className="flex gap-1.5 items-end shrink-0" style={{ height: 80 }}>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-[9px] font-mono text-emerald-400 font-bold tabular-nums">{throttlePct.toFixed(0)}</span>
            <div className="w-6 bg-slate-800 rounded-sm overflow-hidden relative" style={{ height: 60 }}>
              <div
                className="absolute bottom-0 w-full bg-emerald-400 rounded-sm transition-all"
                style={{ height: `${throttlePct}%` }}
              />
            </div>
            <span className="text-[8px] text-slate-500">T</span>
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-[9px] font-mono text-red-400 font-bold tabular-nums">{brakePct.toFixed(0)}</span>
            <div className="w-6 bg-slate-800 rounded-sm overflow-hidden relative" style={{ height: 60 }}>
              <div
                className="absolute bottom-0 w-full bg-red-500 rounded-sm transition-all"
                style={{ height: `${brakePct}%` }}
              />
            </div>
            <span className="text-[8px] text-slate-500">B</span>
          </div>
        </div>

        {/* Fuel */}
        <div className="flex-1">
          <FuelGauge packet={packet} />
        </div>

        <SteeringWheel steer={packet.Steer} />
        <GForceCircle packet={packet} />
      </div>

      {/* Row 4: Power / Torque / Boost arc gauges */}
      <div className="flex items-center justify-center gap-1">
        <PowerTorque packet={packet} />
        <ArcGauge value={packet.Boost} max={30} label="Boost" unit="psi" color="#22d3ee" />
      </div>

      {/* Tires — unified 4-wheel display */}
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Tires</div>
        <TireDiagram packet={packet} />
      </div>

      {/* Grip history — 60s sparklines */}
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Grip History (60s)</div>
        <GripHistory packet={packet} />
      </div>



      {/* Body Attitude */}
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Body Attitude</div>
        <BodyAttitude packet={packet} />
      </div>

      {/* Telemetry History Charts (60s) */}
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Telemetry History (60s)</div>
        <TelemetryCharts packet={packet} />
      </div>

    </div>
  );
}
