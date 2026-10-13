import { useEffect, useRef, useState } from "react";
import type { OverlayData } from "@/lib/streaming-data";
import { m } from "@/paraglide/messages";

type Sample = { time: number; brake?: number; throttle?: number; clutch?: number };
const WINDOW_MS = 10_000;
const MAX_SAMPLES = 600;
const GRAPH = { left: 42, right: 610, top: 16, bottom: 184 };

function pathFor(samples: readonly Sample[], key: "brake" | "throttle" | "clutch") {
  let path = "";
  let active = false;
  let previous: Sample | undefined;
  for (const sample of samples) {
    const value = sample[key];
    if (value === undefined) { active = false; previous = sample; continue; }
    const x = GRAPH.right - ((samples[samples.length - 1]!.time - sample.time) / WINDOW_MS) * (GRAPH.right - GRAPH.left);
    const y = GRAPH.bottom - (value / 100) * (GRAPH.bottom - GRAPH.top);
    const broken = !previous || (sample.time - previous.time > 1000) || previous[key] === undefined;
    path += `${active && !broken ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    active = true;
    previous = sample;
  }
  return path.trim();
}

function current(value: number | undefined) { return value === undefined ? "—" : `${Math.round(value)}%`; }

export function InputGraph({ data }: { data: OverlayData }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const identity = useRef<{ streamId: string; sessionId: number | null; sequence: number } | undefined>(undefined);
  useEffect(() => {
    const frame = data.inputFrame;
    if (data.status !== "live" || !frame) {
      if (identity.current) {
        identity.current = undefined;
        setSamples([]);
      }
      return;
    }
    const prior = identity.current;
    const changed = prior && (prior.streamId !== frame.streamId || prior.sessionId !== frame.sessionId);
    const backwards = prior && !changed && frame.sequence < prior.sequence;
    const duplicate = prior && !changed && !backwards && frame.sequence === prior.sequence;
    if (duplicate) return;
    const sample: Sample = { time: performance.now(), brake: data.brakePct, throttle: data.throttlePct, clutch: data.clutchPct };
    identity.current = frame;
    setSamples((old) => {
      const retained = changed || backwards ? [] : old.filter((entry) => sample.time - entry.time <= WINDOW_MS);
      return [...retained, sample].slice(-MAX_SAMPLES);
    });
  }, [data.status, data.inputFrame?.streamId, data.inputFrame?.sessionId, data.inputFrame?.sequence, data.brakePct, data.throttlePct, data.clutchPct]);

  const axes = [0, 50, 100].map((value) => ({ value, y: GRAPH.bottom - value / 100 * (GRAPH.bottom - GRAPH.top) }));
  const legends = [
    { key: "brake" as const, label: m.streaming_brake(), value: data.brakePct, color: "var(--ch-brake)" },
    { key: "throttle" as const, label: m.streaming_throttle(), value: data.throttlePct, color: "var(--ch-throttle)" },
    { key: "clutch" as const, label: m.streaming_clutch(), value: data.clutchPct, color: "var(--ch-steer)" },
  ];
  const title = m.streaming_inputs_title();
  return <section className="w-full rounded-lg border border-app-border/70 bg-app-surface p-3 text-app-text" aria-label={title}>
    <header className="mb-2"><h2 className="text-app-heading font-semibold">{title}</h2></header>
    <svg className="block h-[168px] w-full overflow-visible" viewBox="0 0 640 208" role="img" aria-label={title}>
      {axes.map(({ value, y }) => <g key={value}><line x1={GRAPH.left} x2={GRAPH.right} y1={y} y2={y} stroke="currentColor" strokeOpacity=".16" strokeWidth="1" /><text x="34" y={y + 4} textAnchor="end" fill="currentColor" opacity=".65" fontSize="11">{value}%</text></g>)}
      <text x={GRAPH.left} y="204" fill="currentColor" opacity=".65" fontSize="11">−10s</text><text x={(GRAPH.left + GRAPH.right) / 2} y="204" textAnchor="middle" fill="currentColor" opacity=".65" fontSize="11">−5s</text><text x={GRAPH.right} y="204" textAnchor="end" fill="currentColor" opacity=".65" fontSize="11">0s</text>
      {legends.map(({ key, color }) => <path key={key} d={pathFor(samples, key)} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={key === "clutch" ? "6 4" : undefined} />)}
      {(samples.length === 1 || !data.inputFrame) && legends.map(({ key, color }) => { const value = samples.length === 1 ? samples[0]![key] : data[key === "brake" ? "brakePct" : key === "throttle" ? "throttlePct" : "clutchPct"]; return value === undefined ? null : <circle key={key} cx={GRAPH.right} cy={GRAPH.bottom - value / 100 * (GRAPH.bottom - GRAPH.top)} r="3" fill={color} />; })}
    </svg>
    <div className="grid grid-cols-3 gap-3 text-app-label text-app-text-muted">{legends.map(({ key, label, value, color }) => <div key={key} className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-1.5"><i className={`h-0.5 w-4 shrink-0 ${key === "brake" ? "bg-[var(--ch-brake)]" : key === "throttle" ? "bg-[var(--ch-throttle)]" : "border-t-2 border-dashed border-[var(--ch-steer)]"}`} aria-hidden="true" />{label}</span><span className="font-semibold tabular-nums" style={{ color }}>{current(value)}</span></div>)}</div>
  </section>;
}
