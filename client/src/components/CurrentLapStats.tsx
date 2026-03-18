import { useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";

interface Props {
  packet: TelemetryPacket | null;
}

interface LapAccumulator {
  lapNumber: number;
  sampleCount: number;
  speedSum: number;
  maxSpeed: number;
  throttleSum: number;
  brakeSum: number;
  rpmSum: number;
  maxRpm: number;
  fullThrottleCount: number;
  fullBrakeCount: number;
  startDistance: number;
}

function getSpeedMph(p: TelemetryPacket): number {
  return Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * 2.23694;
}

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function StatRow({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-xs font-mono text-slate-200 tabular-nums">
        {value}{unit && <span className="text-slate-500 ml-0.5">{unit}</span>}
      </span>
    </div>
  );
}

export function CurrentLapStats({ packet }: Props) {
  const accRef = useRef<LapAccumulator>({
    lapNumber: -1,
    sampleCount: 0,
    speedSum: 0,
    maxSpeed: 0,
    throttleSum: 0,
    brakeSum: 0,
    rpmSum: 0,
    maxRpm: 0,
    fullThrottleCount: 0,
    fullBrakeCount: 0,
    startDistance: 0,
  });

  useEffect(() => {
    if (!packet) return;

    const acc = accRef.current;

    // Reset on new lap
    if (packet.LapNumber !== acc.lapNumber) {
      acc.lapNumber = packet.LapNumber;
      acc.sampleCount = 0;
      acc.speedSum = 0;
      acc.maxSpeed = 0;
      acc.throttleSum = 0;
      acc.brakeSum = 0;
      acc.rpmSum = 0;
      acc.maxRpm = 0;
      acc.fullThrottleCount = 0;
      acc.fullBrakeCount = 0;
      acc.startDistance = packet.DistanceTraveled;
    }

    const speed = getSpeedMph(packet);
    const throttle = packet.Accel / 255;
    const brake = packet.Brake / 255;

    acc.sampleCount++;
    acc.speedSum += speed;
    acc.maxSpeed = Math.max(acc.maxSpeed, speed);
    acc.throttleSum += throttle;
    acc.brakeSum += brake;
    acc.rpmSum += packet.CurrentEngineRpm;
    acc.maxRpm = Math.max(acc.maxRpm, packet.CurrentEngineRpm);
    if (throttle > 0.95) acc.fullThrottleCount++;
    if (brake > 0.95) acc.fullBrakeCount++;
  });

  if (!packet) return null;

  const acc = accRef.current;
  const n = Math.max(acc.sampleCount, 1);
  const distance = packet.DistanceTraveled - acc.startDistance;

  return (
    <div className="p-3 space-y-1">
      <div className="flex justify-between items-end mb-2">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider">Current Lap</div>
          <div className="text-xl font-mono font-semibold text-white tabular-nums">
            {formatLapTime(packet.CurrentLap)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">Lap {packet.LapNumber}</div>
          <div className="text-xs font-mono text-slate-400">{(distance / 1000).toFixed(2)} km</div>
        </div>
      </div>

      <div className="border-t border-slate-800 pt-1">
        <StatRow label="Avg Speed" value={(acc.speedSum / n).toFixed(1)} unit="mph" />
        <StatRow label="Max Speed" value={acc.maxSpeed.toFixed(1)} unit="mph" />
        <StatRow label="Avg RPM" value={(acc.rpmSum / n).toFixed(0)} />
        <StatRow label="Peak RPM" value={acc.maxRpm.toFixed(0)} />
        <StatRow label="Avg Throttle" value={((acc.throttleSum / n) * 100).toFixed(0)} unit="%" />
        <StatRow label="Full Throttle" value={((acc.fullThrottleCount / n) * 100).toFixed(0)} unit="%" />
        <StatRow label="Avg Brake" value={((acc.brakeSum / n) * 100).toFixed(0)} unit="%" />
        <StatRow label="Full Brake" value={((acc.fullBrakeCount / n) * 100).toFixed(0)} unit="%" />
      </div>
    </div>
  );
}
