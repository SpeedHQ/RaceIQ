import { useEffect, useRef, useState } from "react";
import type { TelemetryPacket } from "@shared/types";
import { client } from "@/lib/rpc";
import { GripSparkline, GRIP_MAX_SAMPLES } from "./GripSparkline";

/**
 * GripHistory — Manages a per-wheel rolling buffer of combined slip values.
 * Seeds from server history on mount so the chart isn't empty after page refresh.
 * Downsamples 60Hz telemetry to ~10Hz to keep buffer sizes reasonable.
 */
export function GripHistory({ packet }: { packet: TelemetryPacket }) {
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
