import { useEffect, useState, useRef, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";
import { CAR_CLASS_NAMES, DRIVETRAIN_NAMES } from "@shared/types";
import { SteeringWheel } from "./SteeringWheel";

const GRIP_HISTORY_SECONDS = 60;
const GRIP_SAMPLE_RATE = 10; // samples per second
const GRIP_MAX_SAMPLES = GRIP_HISTORY_SECONDS * GRIP_SAMPLE_RATE;

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

function GripHistory({ packet }: { packet: TelemetryPacket }) {
  const historyRef = useRef<{ fl: number[]; fr: number[]; rl: number[]; rr: number[] }>({
    fl: [], fr: [], rl: [], rr: [],
  });
  const [renderKey, setRenderKey] = useState(0);
  const frameRef = useRef(0);

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

function formatLapTime(seconds: number): string {
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

function tempColor(t: number): string {
  if (t < 150) return "text-blue-400";
  if (t < 220) return "text-emerald-400";
  if (t < 280) return "text-amber-400";
  return "text-red-400";
}

function tempBg(t: number): string {
  if (t < 150) return "bg-blue-500/20 border-blue-500/40";
  if (t < 220) return "bg-emerald-500/20 border-emerald-500/40";
  if (t < 280) return "bg-amber-500/20 border-amber-500/40";
  return "bg-red-500/20 border-red-500/40";
}

function wearBarColor(w: number): string {
  if (w > 0.75) return "bg-emerald-400";
  if (w > 0.5) return "bg-yellow-400";
  if (w > 0.25) return "bg-orange-400";
  return "bg-red-500";
}

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

function WheelCard({ label, temp, wear, combined }: {
  label: string;
  temp: number;
  wear: number;
  combined: number;
}) {
  return (
    <div className={`rounded-lg border p-2 transition-colors ${tempBg(temp)}`}>
      {/* Header: label + traction badge */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-slate-400 uppercase">{label}</span>
        <span className={`text-[9px] font-mono font-bold px-1 py-px rounded ${gripColor(combined)} bg-slate-900/60 ${gripPulse(combined)}`}>
          {gripLabel(combined)}
        </span>
      </div>

      {/* Temp */}
      <div className={`text-xl font-mono font-bold tabular-nums leading-none mb-1.5 ${tempColor(temp)}`}>
        {temp.toFixed(0)}°
      </div>

      {/* Wear bar */}
      {wear >= 0 ? (
        <div className="flex items-center gap-1">
          <div className="flex-1 h-1.5 bg-slate-900/50 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${wearBarColor(wear)}`}
              style={{ width: `${wear * 100}%` }}
            />
          </div>
          <span className="text-[9px] font-mono text-slate-400">{(wear * 100).toFixed(0)}%</span>
        </div>
      ) : (
        <div className="text-[9px] text-slate-600 italic">n/a</div>
      )}
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

function TireDiagram({ packet }: { packet: TelemetryPacket }) {
  const wheels = [
    { label: "FL", temp: packet.TireTempFL, wear: packet.TireWearFL, combined: Math.abs(packet.TireCombinedSlipFL) },
    { label: "FR", temp: packet.TireTempFR, wear: packet.TireWearFR, combined: Math.abs(packet.TireCombinedSlipFR) },
    { label: "RL", temp: packet.TireTempRL, wear: packet.TireWearRL, combined: Math.abs(packet.TireCombinedSlipRL) },
    { label: "RR", temp: packet.TireTempRR, wear: packet.TireWearRR, combined: Math.abs(packet.TireCombinedSlipRR) },
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
      <WheelCard {...wheels[0]} />
      <div className="flex gap-2">
        <SuspBar norm={susp[0]} />
        <SuspBar norm={susp[1]} />
      </div>
      <WheelCard {...wheels[1]} />

      {/* Divider */}
      <div className="col-span-3 h-px bg-slate-700/30" />

      {/* Rear axle */}
      <WheelCard {...wheels[2]} />
      <div className="flex gap-2">
        <SuspBar norm={susp[2]} />
        <SuspBar norm={susp[3]} />
      </div>
      <WheelCard {...wheels[3]} />
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
    <div className="grid gap-4 p-4">
      {/* Car Info */}
      {carName && (
        <div>
          <div className="text-lg font-semibold text-white truncate">{carName}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-cyan-400">
              {CAR_CLASS_NAMES[packet.CarClass] ?? "?"} {packet.CarPerformanceIndex}
            </span>
            <span className="text-xs text-slate-500">
              {DRIVETRAIN_NAMES[packet.DrivetrainType] ?? "?"} &middot; {packet.NumCylinders}cyl
            </span>
          </div>
        </div>
      )}

      {/* Speed + Gear */}
      <div className="flex items-end gap-4">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider">Speed</div>
          <div className="text-5xl font-mono font-bold text-white tabular-nums">
            {speed.toFixed(0)}
          </div>
          <div className="text-xs text-slate-500">mph</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Gear</div>
          <div className="text-5xl font-mono font-bold text-cyan-400 tabular-nums">
            {packet.Gear === 0 ? "R" : packet.Gear === 11 ? "N" : packet.Gear}
          </div>
        </div>
      </div>

      {/* Steering Wheel */}
      <div className="flex justify-center">
        <SteeringWheel steer={packet.Steer} />
      </div>

      {/* RPM */}
      <div>
        <div className="flex justify-between text-xs text-slate-500 mb-1">
          <span>RPM</span>
          <span className="font-mono">{packet.CurrentEngineRpm.toFixed(0)}</span>
        </div>
        <GaugeBar
          value={packet.CurrentEngineRpm}
          max={packet.EngineMaxRpm}
          color={rpmPct > 90 ? "bg-red-500" : rpmPct > 70 ? "bg-amber-400" : "bg-cyan-400"}
        />
      </div>

      {/* Throttle / Brake */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>Throttle</span>
            <span className="font-mono">{throttlePct.toFixed(0)}%</span>
          </div>
          <GaugeBar value={throttlePct} max={100} color="bg-emerald-400" />
        </div>
        <div>
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>Brake</span>
            <span className="font-mono">{brakePct.toFixed(0)}%</span>
          </div>
          <GaugeBar value={brakePct} max={100} color="bg-red-500" />
        </div>
      </div>

      {/* Lap Info */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/50 rounded p-3">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Lap</div>
          <div className="text-2xl font-mono font-semibold text-white tabular-nums">
            {packet.LapNumber}
          </div>
        </div>
        <div className="bg-slate-800/50 rounded p-3">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Lap Time</div>
          <div className="text-2xl font-mono font-semibold text-white tabular-nums">
            {formatLapTime(packet.CurrentLap)}
          </div>
        </div>
      </div>

      {/* Last Lap / Best Lap */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/50 rounded p-2">
          <div className="text-xs text-slate-500">Last Lap</div>
          <div className="text-sm font-mono text-slate-300 tabular-nums">
            {formatLapTime(packet.LastLap)}
          </div>
        </div>
        <div className="bg-slate-800/50 rounded p-2">
          <div className="text-xs text-slate-500">Best Lap</div>
          <div className="text-sm font-mono text-purple-400 tabular-nums">
            {formatLapTime(packet.BestLap)}
          </div>
        </div>
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

    </div>
  );
}
