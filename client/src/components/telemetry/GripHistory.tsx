import { getGame } from "@shared/games/registry";
import { resolveGripDemand } from "@shared/racing/analysis/metric-values";
import { useEffect, useRef, useState } from "react";
import { client } from "@/lib/rpc";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";

/**
 * GripHistory — Manages a per-wheel rolling buffer of combined slip values.
 * Seeds from server history on mount so the chart isn't empty after page refresh.
 * Downsamples 60Hz telemetry to ~10Hz to keep buffer sizes reasonable.
 */
export function GripHistory({ packet, view }: { packet?: TelemetryPacket; view?: LiveTelemetryView }) {
  const historyRef = useRef<{ fl: number[]; fr: number[]; rl: number[]; rr: number[] }>({
    fl: [],
    fr: [],
    rl: [],
    rr: [],
  });
  const [gripData, setGripData] = useState<{ fl: number[]; fr: number[]; rl: number[]; rr: number[] }>({ fl: [], fr: [], rl: [], rr: [] });
  const [renderKey, setRenderKey] = useState(0);
  const frameRef = useRef(0);
  const fetchedRef = useRef(false);

  // Seed from server on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    client.api["grip-history"]
      .$get()
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
    if (!packet && !view) return;
    frameRef.current++;
    if (frameRef.current % 6 !== 0) return;
    const h = historyRef.current;
    const analysis = getGame(view?.simulator ?? packet?.gameId ?? "iracing").telemetry.analysis;
    const frame = view ? { values: { "tires.tire-combined-slip": view.tires.combinedSlip, "tires.tire-slip-ratio": view.tires.slipRatio, "tires.tire-slip-angle": view.tires.slipAngleRad } } : null;
    const resolved = frame ? resolveGripDemand(frame, analysis.gripDemand) : null;
    const grip = resolved ? { fl: resolved[0] ?? 0, fr: resolved[1] ?? 0, rl: resolved[2] ?? 0, rr: resolved[3] ?? 0 } : view?.tires.combinedSlip;
    h.fl.push(Math.abs(grip?.fl ?? packet?.TireCombinedSlipFL ?? 0));
    h.fr.push(Math.abs(grip?.fr ?? packet?.TireCombinedSlipFR ?? 0));
    h.rl.push(Math.abs(grip?.rl ?? packet?.TireCombinedSlipRL ?? 0));
    h.rr.push(Math.abs(grip?.rr ?? packet?.TireCombinedSlipRR ?? 0));

    if (h.fl.length > GRIP_MAX_SAMPLES) {
      h.fl.shift();
      h.fr.shift();
      h.rl.shift();
      h.rr.shift();
    }

    setGripData({ fl: h.fl, fr: h.fr, rl: h.rl, rr: h.rr });
    setRenderKey((v) => v + 1);
  }, [packet, view]);
  return (
    <div className="grid grid-cols-2 gap-2">
      <GripSparkline data={gripData.fl} label="FL" renderKey={renderKey} />
      <GripSparkline data={gripData.fr} label="FR" renderKey={renderKey} />
      <GripSparkline data={gripData.rl} label="RL" renderKey={renderKey} />
      <GripSparkline data={gripData.rr} label="RR" renderKey={renderKey} />
    </div>
  );
}
