import { getGame } from "@shared/games/registry";
import { resolveGripDemand } from "@shared/racing/analysis/metric-values";
import { useEffect, useRef, useState } from "react";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";
import { GRIP_MAX_SAMPLES, GripSparkline } from "./GripSparkline";

/**
 * Maintains canonical per-wheel combined-slip samples at about 10 Hz.
 */
export function GripHistory({ view }: { view: LiveTelemetryView }) {
  const historyRef = useRef<{ fl: number[]; fr: number[]; rl: number[]; rr: number[] }>({
    fl: [],
    fr: [],
    rl: [],
    rr: [],
  });
  const [gripData, setGripData] = useState<{ fl: number[]; fr: number[]; rl: number[]; rr: number[] }>({ fl: [], fr: [], rl: [], rr: [] });
  const [renderKey, setRenderKey] = useState(0);
  const frameRef = useRef(0);
  const streamRef = useRef(view.streamId);
  useEffect(() => {
    if (streamRef.current !== view.streamId) {
      streamRef.current = view.streamId;
      historyRef.current = { fl: [], fr: [], rl: [], rr: [] };
      setGripData({ fl: [], fr: [], rl: [], rr: [] });
      frameRef.current = 0;
    }
    frameRef.current++;
    if (frameRef.current % 6 !== 0) return;
    const analysis = getGame(view.simulator).telemetry.analysis;
    if (!analysis?.gripDemand || analysis.gripDemand.source === "unavailable") return;
    const combinedSlip = view.tires.combinedSlip;
    const slipRatio = view.tires.slipRatio;
    const slipAngle = view.tires.slipAngleRad;
    const values = {
      "motion.speed": view.motion.speedMps,
      "inputs.steer": view.inputs.steer,
      "tires.tire-combined-slip": combinedSlip && [combinedSlip.fl, combinedSlip.fr, combinedSlip.rl, combinedSlip.rr],
      "tires.tire-slip-ratio": slipRatio && [slipRatio.fl, slipRatio.fr, slipRatio.rl, slipRatio.rr],
      "tires.tire-slip-angle": slipAngle && [slipAngle.fl, slipAngle.fr, slipAngle.rl, slipAngle.rr],
      "tires.wheel-rotation-speed": view.tires.rotationRadS && Object.values(view.tires.rotationRadS),
      "tires.tire-radius": view.tires.radiusM && Object.values(view.tires.radiusM),
    };
    const resolved = resolveGripDemand({ values }, analysis.gripDemand);
    if (!resolved || resolved.length < 4 || !resolved.slice(0, 4).every((value) => typeof value === "number" && Number.isFinite(value))) return;
    const history = historyRef.current;
    history.fl.push(Math.abs(resolved[0] as number));
    history.fr.push(Math.abs(resolved[1] as number));
    history.rl.push(Math.abs(resolved[2] as number));
    history.rr.push(Math.abs(resolved[3] as number));

    if (history.fl.length > GRIP_MAX_SAMPLES) {
      history.fl.shift();
      history.fr.shift();
      history.rl.shift();
      history.rr.shift();
    }

    setGripData({ fl: history.fl, fr: history.fr, rl: history.rl, rr: history.rr });
    setRenderKey((current) => current + 1);
  }, [view.sequence, view.simulator, view.streamId, view.tires.combinedSlip, view.tires.slipAngleRad, view.tires.slipRatio]);
  return (
    <div className="grid grid-cols-2 gap-2">
      <GripSparkline data={gripData.fl} label="FL" renderKey={renderKey} />
      <GripSparkline data={gripData.fr} label="FR" renderKey={renderKey} />
      <GripSparkline data={gripData.rl} label="RL" renderKey={renderKey} />
      <GripSparkline data={gripData.rr} label="RR" renderKey={renderKey} />
    </div>
  );
}
