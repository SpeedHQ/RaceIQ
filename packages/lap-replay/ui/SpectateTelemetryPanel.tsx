import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useMessages } from "./host"
import { useReplayHost } from "./host"
import { getTelemetryVariable, isTelemetryVariableId } from "@raceiq/shared/telemetry/catalog/query";
import { useUnits } from "./host"
import { getSemanticCanvasContext } from "@raceiq/scene-3d/rendering/css-canvas";
import { DELTA_COLOR_VARS, deltaColor, WHEEL_COLOR_VARS } from "@raceiq/scene-3d/colors";

import type { SpectateController, ReplaySession, SpectateReading, SpectateSnapshot } from "../contracts/spectate";
import { ERS_DEPLOY_MODES, readERSDeployMode, buildERSModeRuns } from "./spectate-ers-mode";
import { buildSpectateChannels, channelValue, type SpectateChannel } from "./spectate-channels";
const A_COLOR = "var(--comparison-lap-a)";
const B_COLOR = "var(--comparison-lap-b)";

export type Category = "inputs" | "motion" | "engine" | "fuel" | "tires" | "suspension" | "brakes" | "other";
export const CATEGORY_LABELS = {
  inputs: "overlay_inputs", motion: "analyse_section_dynamics", engine: "label_engine", fuel: "label_fuel",
  tires: "label_tires", suspension: "chart_suspension", brakes: "spectate_brake", other: "analyse_other_group",
} as const;
const WINDOW_STORAGE_KEY = "spectate-chart-window-seconds";
function readWindowSeconds(): 5 | 10 {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(WINDOW_STORAGE_KEY) === "5" ? 5 : 10; }
  catch { return 10; }
}
export function classify(channel: SpectateChannel): Category {
  const meta = isTelemetryVariableId(channel.id) ? getTelemetryVariable(channel.id) : undefined;
  const id = meta?.id ?? channel.id;
  const groupId = meta?.parentId ?? "";
  if (id.startsWith("inputs.")) return "inputs";
  if (id.startsWith("motion.") || channel.derived === "g-force" || channel.derived === "balance") return "motion";
  if (groupId.startsWith("engine") || id.startsWith("engine.")) return "engine";
  if (groupId.startsWith("fuel") || id.startsWith("fuel.")) return "fuel";
  if (groupId.startsWith("tires") || groupId.startsWith("wheels") || id.startsWith("tire.") || id.startsWith("tires.") || id.startsWith("tyres.") || id.startsWith("wheels.") || channel.derived === "grip" || channel.derived === "wear-rate") return "tires";
  if (groupId.startsWith("suspension") || id.startsWith("suspension.") || channel.derived === "compression-bias") return "suspension";
  if (groupId.startsWith("brakes") || id.startsWith("brakes.")) return "brakes";
  return "other";
}
const WHEEL_ORDER = ["FL", "FR", "RL", "RR"];
function isFourWheelChannel(channel: SpectateChannel): boolean {
  return channel.components.length === WHEEL_ORDER.length
    && channel.components.every((component, index) => component.label === WHEEL_ORDER[index]);
}
// Anchor vertices to recorded time, not the moving viewport. Otherwise sharp
// B inputs are resampled into different shapes on every playback frame.
const WINDOW_TICKS: Record<5 | 10, number[]> = {
  5: Array.from({ length: 102 }, (_, i) => i - 50),
  10: Array.from({ length: 202 }, (_, i) => i - 100),
};
const windowCache = new WeakMap<SpectateController, { key: string; points: { time: number; a: SpectateReading | null; b: SpectateReading | null }[] }>();
function sampleWindow(controller: SpectateController, snapshot: SpectateSnapshot, seconds: 5 | 10) {
  const tick = Math.floor(snapshot.time * 10);
  const key = `${seconds}:${tick}:${snapshot.positionLock}`;
  const cached = windowCache.get(controller);
  if (cached?.key === key) return cached.points;
  const points = WINDOW_TICKS[seconds].map((offset) => {
    const time = (tick + offset) / 10;
    const { a, b } = controller.sample(time, false);
    return { time, a, b };
  });
  windowCache.set(controller, { key, points });
  return points;
}

function ChartRow({
  channel,
  windowSeconds,
  controller,
  snapshot,
  convert,
  single = false,
  groupComponents = false,
}: {
  channel: SpectateChannel;
  windowSeconds: 5 | 10;
  controller: SpectateController;
  snapshot: SpectateSnapshot;
  convert: (id: string, value: number) => number;
  single?: boolean;
  groupComponents?: boolean;
}) { const { syncCanvasSize } = useReplayHost(); const m = useMessages(); const root = useRef<HTMLDivElement>(null);
const canvas = useRef<HTMLCanvasElement>(null);
const [visible, setVisible] = useState(false);
const [width, setWidth] = useState(0);
const primaryColor = !single ? A_COLOR : channel.id === "inputs.brake" ? "var(--ch-brake)" : channel.id === "inputs.accel" ? "var(--ch-throttle)" : "var(--app-accent)";
const points = useMemo(() => (visible ? sampleWindow(controller, snapshot, windowSeconds) : []), [visible, controller, windowSeconds, snapshot.time, snapshot.generation, snapshot.positionLock]);
useEffect(() => {
  const node = root.current;
  if (!node) return;
  const resize = new ResizeObserver(() => setWidth(node.clientWidth));
  resize.observe(node);
  return () => resize.disconnect();
}, []);
useEffect(() => {
  const node = root.current;
  if (!node) return;
  const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: node.closest("[data-spectate-scroll]") });
  observer.observe(node);
  return () => observer.disconnect();
}, []);
useEffect(() => {
  if (!visible) return;
  const node = canvas.current;
  const host = root.current;
  if (!node || !host) return;
  const width = host.clientWidth;
  const height = 72;
  syncCanvasSize(node, width, height, window.devicePixelRatio || 1, false);
  const ctx = getSemanticCanvasContext(node);
  if (!ctx) return;
  ctx.setTransform(node.width / width, 0, 0, node.height / height, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const component = channel.components[0] ?? { key: "", label: "" };
  const series = groupComponents
    ? channel.components.map((wheel, index) => ({ side: "a" as const, component: wheel, color: WHEEL_COLOR_VARS[index]! }))
    : single || channel.derived === "delta"
      ? [{ side: "a" as const, component, color: primaryColor }]
      : [{ side: "a" as const, component, color: A_COLOR }, { side: "b" as const, component, color: B_COLOR }];
  const vals = points.flatMap(({ a, b }) => series.map(({ side, component }) => value(side === "a" ? a : b, channel, side, component.key))).filter((v): v is number => v !== null);
  const min = vals.length ? Math.min(...vals) : -1;
  const max = vals.length ? Math.max(...vals) : 1;
  const span = max - min || 1;
  const left = 0,
    right = width - 6,
    top = 5,
    bottom = height - 5;
  const y = (v: number) => bottom - ((v - min) / span) * (bottom - top);
  ctx.strokeStyle = "var(--app-border)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo((left + right) / 2, top);
  ctx.lineTo((left + right) / 2, bottom);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  for (const { side, color, component } of series) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const deltaFill = channel.derived === "delta" ? new Path2D() : null;
    const zeroY = Math.max(top, Math.min(bottom, y(0)));
    let lastX = left;
    let active = false;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const reading = side === "a" ? p.a : p.b;
      const previous = i ? (side === "a" ? points[i - 1].a : points[i - 1].b) : null;
      const v = value(reading, channel, side, component.key);
      const pv = value(previous, channel, side, component.key);
      if (v === null) {
        if (active && deltaFill) {
          deltaFill.lineTo(lastX, zeroY);
          deltaFill.closePath();
        }
        active = false;
        continue;
      }
      const x = left + ((p.time - snapshot.time + windowSeconds) / (windowSeconds * 2)) * (right - left);
      if (active) {
        if (channel.id === "inputs.gear" && pv !== null) {
          ctx.lineTo(x, y(pv));
          ctx.lineTo(x, y(v));
        } else ctx.lineTo(x, y(v));
      } else {
        ctx.moveTo(x, y(v));
        deltaFill?.moveTo(x, zeroY);
        active = true;
      }
      deltaFill?.lineTo(x, y(v));
      lastX = x;
    }
    if (deltaFill) {
      if (active) {
        deltaFill.lineTo(lastX, zeroY);
        deltaFill.closePath();
      }
      // Clip the same trace at zero so crossings change color precisely.
      for (const [index, deltaColor] of DELTA_COLOR_VARS.entries()) {
        ctx.save();
        const clipTop = index === 0 ? zeroY : top;
        const clipBottom = index === 0 ? bottom : zeroY;
        const region = new Path2D();
        region.rect(left, clipTop, right - left, clipBottom - clipTop);
        ctx.clip(region);
        ctx.strokeStyle = deltaColor;
        ctx.stroke();
        ctx.fillStyle = `color-mix(in srgb, ${deltaColor} 20%, transparent)`;
        ctx.fill(deltaFill);
        ctx.restore();
      }
    } else ctx.stroke();
  }
  ctx.restore();
}, [visible, points, channel, convert, width, windowSeconds, snapshot.time, groupComponents, single, primaryColor]);
const nowA = value(snapshot.a, channel, "a");
const nowB = channel.derived === "delta" ? null : value(snapshot.b, channel, "b");
const label = channel.label + (!groupComponents && channel.components[0]?.label ? ` ${channel.components[0].label}` : "");
const nowComponents = groupComponents ? channel.components.map((component, index) => ({
  component,
  value: value(snapshot.a, channel, "a", component.key),
  color: WHEEL_COLOR_VARS[index]!,
})) : [];
return (
  <div
    ref={root}
    data-channel-id={channel.id}
    data-component={groupComponents ? "" : channel.components[0]?.key ?? ""}
    data-component-count={groupComponents ? channel.components.length : 1}
    data-axis-start={-windowSeconds}
    data-axis-end={windowSeconds}
    data-center-time={snapshot.time}
    className="border-t border-app-border py-2"
    aria-label={label}
  >
    <div className="flex items-center justify-between gap-2 text-app-compact text-app-text-secondary">
      <span>{label}</span>
      <span className="text-app-text-dim">{channel.unit}</span>
      <span className="ml-auto flex gap-2 tabular-nums">
        {groupComponents
          ? nowComponents.map(({ component, value: current, color }) => <span key={component.key} data-wheel={component.label} style={{ color }}>{component.label} {format(current)}</span>)
          : <><span style={{ color: channel.derived === "delta" ? nowA === null || nowA === 0 ? "var(--app-text-secondary)" : deltaColor(nowA) : primaryColor }}>{format(nowA)}</span>
            {channel.derived !== "delta" && !single && <span style={{ color: B_COLOR }}>{format(nowB)}</span>}</>}
      </span>
    </div>
    <canvas
      ref={canvas}
      className="block h-[72px] w-full"
      role="img"
      aria-label={groupComponents ? `${label}; ${nowComponents.map(({ component, value: current }) => `${component.label} ${format(current)}`).join(", ")}` : channel.derived === "delta" ? `${label}; A − B ${format(nowA)}` : single ? `${label}; ${format(nowA)}` : `${label}; A ${format(nowA)}, B ${format(nowB)}`}
      data-current-a={format(nowA)}
      data-current-b={single || channel.derived === "delta" ? undefined : format(nowB)}
      title={channel.derived === "delta" || single ? undefined : snapshot.b ? m.spectate_b_sampled_at_time({ time: snapshot.b.time.toFixed(2) }) : m.spectate_b_unavailable()}
    />
  </div>
);
function value(reading: SpectateReading | null, source: SpectateChannel, side: "a" | "b", component = source.components[0]?.key ?? ""): number | null {
  const raw = channelValue(reading, source, component, side);
  return raw === null ? null : source.derived ? raw : convert(source.id, raw);
}
function format(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(channel.id === "inputs.gear" ? 0 : 2);
} }
function ERSModeChartRow({ windowSeconds, controller, snapshot, single }: { windowSeconds: 5 | 10; controller: SpectateController; snapshot: SpectateSnapshot; single?: boolean }) { const m = useMessages(); const root = useRef<HTMLDivElement>(null);
const [visible, setVisible] = useState(false);
const [width, setWidth] = useState(0);
const points = useMemo(() => (visible ? sampleWindow(controller, snapshot, windowSeconds) : []), [visible, controller, windowSeconds, snapshot.time, snapshot.generation, snapshot.positionLock]);
const runsA = useMemo(() => buildERSModeRuns(points, "a"), [points]);
const runsB = useMemo(() => single ? [] : buildERSModeRuns(points, "b"), [points, single]);
const plotWidth = Math.max(0, width - 22);
const scale = plotWidth / (windowSeconds * 2);
useEffect(() => {
  const node = root.current;
  if (!node) return;
  const resize = new ResizeObserver(() => setWidth(node.clientWidth));
  resize.observe(node);
  return () => resize.disconnect();
}, []);
useEffect(() => {
  const node = root.current;
  if (!node) return;
  const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: node.closest("[data-spectate-scroll]") });
  observer.observe(node);
  return () => observer.disconnect();
}, []);
const modeA = readERSDeployMode(snapshot.a);
const modeB = readERSDeployMode(snapshot.b);
return (
  <div ref={root} className="border-t border-app-border py-2" data-channel-id="fuel.ers-deploy-mode">
    <div className="flex items-center justify-between gap-2 text-app-compact text-app-text-secondary">
      <span>{m.f1live_ers_label()}</span>
      <span className="flex gap-2">
        <span style={{ color: single ? "var(--app-accent)" : A_COLOR }}>{single ? "" : "A "}{modeA === null ? m.analyse_unavailable() : m[ERS_DEPLOY_MODES[modeA].label]()}</span>
        {!single && <span style={{ color: B_COLOR }}>B {modeB === null ? m.analyse_unavailable() : m[ERS_DEPLOY_MODES[modeB].label]()}</span>}
      </span>
    </div>
    <svg className="block h-[72px] w-full" viewBox={`0 0 ${Math.max(1, width)} 72`} role="img" aria-label={single ? `${m.f1live_ers_label()}; ${modeA === null ? m.analyse_unavailable() : m[ERS_DEPLOY_MODES[modeA].label]()}` : `${m.f1live_ers_label()}; A ${modeA === null ? m.analyse_unavailable() : m[ERS_DEPLOY_MODES[modeA].label]()}, B ${modeB === null ? m.analyse_unavailable() : m[ERS_DEPLOY_MODES[modeB].label]()}`} data-current-a={modeA ?? "unavailable"} data-current-b={single ? undefined : modeB ?? "unavailable"}>
      {!single && <>
        <text x="0" y="21" dominantBaseline="middle" fontSize="10" fill={A_COLOR}>A</text>
        <text x="0" y="49" dominantBaseline="middle" fontSize="10" fill={B_COLOR}>B</text>
      </>}
      <svg x="16" width={plotWidth} height="72" overflow="hidden" aria-hidden="true">
        <g transform={`translate(${-(snapshot.time - windowSeconds) * scale}, 0)`}>
          {[runsA, runsB].map((runs, side) => runs.map((run, index) => (
            <rect key={`${side}:${run.mode}:${index}`} data-ers-side={side === 0 ? "a" : "b"} data-ers-mode={run.mode}
              x={run.start * scale} y={side === 0 ? 15 : 43} width={(run.end - run.start) * scale} height="12"
              fill={ERS_DEPLOY_MODES[run.mode]!.color} />
          )))}
        </g>
      </svg>
      <line x1={16 + plotWidth / 2} x2={16 + plotWidth / 2} y1="8" y2="62" stroke="var(--app-border)" strokeWidth="1" />
    </svg>
    <div className="flex flex-wrap gap-x-2 gap-y-1 text-app-micro text-app-text-secondary">
      {ERS_DEPLOY_MODES.map((mode) => (
        <span key={mode.value} className="inline-flex items-center gap-1">
          <i className="size-1.5 rounded-full" style={{ background: mode.color }} />
          {m[mode.label]()}
        </span>
      ))}
    </div>
  </div>
); }


export function SpectateTelemetryPanel({ pair, controller, headerTarget }: { pair: ReplaySession; controller: SpectateController; headerTarget: HTMLDivElement | null }) { const { getLocale } = useReplayHost(); const m = useMessages(); const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
const units = useUnits(pair.gameId);
const channels = useMemo(
  () =>
    buildSpectateChannels(pair)
      .filter((channel) => channel.derived === "delta"
        ? pair.b !== null
        : [pair.a, ...(pair.b ? [pair.b] : [])].some((lap, sideIndex) =>
          lap.samples.some((sample) =>
            channel.components.some((component) => channelValue(
              { time: sample.time, distance: sample.distance, pose: null, values: sample.values },
              channel,
              component.key,
              sideIndex === 0 ? "a" : "b",
            ) !== null),
          ),
        ),
      )
      .flatMap((channel) => {
        const groupWheels = !pair.b && isFourWheelChannel(channel);
        const components = groupWheels ? [null] : channel.components;
        return components.map((component) => ({
          ...channel,
          label:
            channel.derived === "g-force" ? m.spectate_g_force()
              : channel.derived === "balance" ? m.spectate_balance()
                : channel.derived === "grip" ? m.spectate_grip_demand()
                  : channel.derived === "compression-bias" ? m.analyse_suspension_compression_bias()
                    : channel.derived === "wear-rate" ? m.analyse_wheels_wear_s()
                      : channel.derived === "delta" ? m.spectate_time_delta() : channel.label,
          unit: channel.id === "motion.speed" ? units.speedLabel : channel.unit === "°C" || channel.unit === "C" ? units.tempLabel : channel.unit,
          components: component
            ? [{ ...component, label: channel.derived === "compression-bias" ? (component.key === "front" ? m.analyse_suspension_front() : m.analyse_suspension_left()) : component.label }]
            : channel.components,
        }));
      })
      .sort((a, b) => Number(b.derived === "delta") - Number(a.derived === "delta")),
  [pair, units.speedLabel, units.tempLabel],
);
const [windowSeconds, setWindowSeconds] = useState<5 | 10>(readWindowSeconds);
useEffect(() => {
  try { localStorage.setItem(WINDOW_STORAGE_KEY, String(windowSeconds)); } catch { /* storage unavailable */ }
}, [windowSeconds]);
const [category, setCategory] = useState<Category>("inputs");
const hasERSModeData = useMemo(() =>
  [pair.a, ...(pair.b ? [pair.b] : [])].some((lap) => lap.samples.some((sample) => readERSDeployMode(sample) !== null)),
[pair]);
const categorized = useMemo(() => channels.filter((channel) => channel.derived !== "delta").map((channel) => ({ channel, category: classify(channel) })), [channels]);
const presentCategories = useMemo(() => (["inputs", "motion", "engine", "fuel", "tires", "suspension", "brakes", "other"] as const)
  .filter((item) => item === "inputs" || categorized.some(({ category: itemCategory }) => itemCategory === item) || (item === "fuel" && hasERSModeData)), [categorized, hasERSModeData]);
useEffect(() => {
  if (!presentCategories.includes(category)) setCategory("inputs");
}, [category, presentCategories]);
useEffect(() => setCategory("inputs"), [pair.gameId, pair.comparison.lapA.id, pair.comparison.lapB?.id]);
const tabs = presentCategories;
const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
  const index = tabs.indexOf(category as (typeof tabs)[number]);
  const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
    : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
  if (next >= 0) {
    event.preventDefault();
    setCategory(tabs[next]);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
};
const locale = getLocale();
const formatSeconds = useMemo(() => new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "narrow", maximumFractionDigits: 0 }).format, [locale]);
const scroll = useRef<HTMLDivElement>(null);
const convert = (id: string, value: number) => {
  if (id === "motion.speed") return units.speed(value);
  const unit = getTelemetryVariable(id).canonicalUnit;
  if (unit === "°C" || unit === "C") return units.temp(value);
  return value;
};
return (
  <div className="h-full w-full min-h-0 min-w-0 flex-1 flex flex-col bg-app-bg">
    {headerTarget && createPortal(
      <select
        aria-label={m.review_range()}
        className="rounded-sm border border-app-border-input bg-app-surface px-1.5 py-1 text-app-text"
        value={windowSeconds}
        onChange={(event) => setWindowSeconds(event.target.value === "5" ? 5 : 10)}
      >
        {([5, 10] as const).map((seconds) => (
          <option key={seconds} value={seconds}>±{formatSeconds(seconds)}</option>
        ))}
      </select>,
      headerTarget,
    )}
    <div role="tablist" aria-label={m.label_category()} className="flex gap-1 overflow-x-auto px-3 pt-3 pb-2">
      {tabs.map((item) => (
        <button key={item} type="button" role="tab" aria-selected={category === item} tabIndex={category === item ? 0 : -1}
          id={`spectate-category-${item}`} aria-controls="spectate-telemetry-channels"
          onClick={() => setCategory(item)} onKeyDown={onTabKeyDown}
          className={`shrink-0 rounded px-2 py-1 text-app-micro ${category === item ? "bg-app-accent text-app-on-filled" : "text-app-text-secondary"}`}>
          {m[CATEGORY_LABELS[item]]()}
        </button>
      ))}
    </div>
    <div className="flex justify-between px-4 pb-2 text-app-micro text-app-text-muted">
      <span>{formatSeconds(-windowSeconds)}</span>
      <span>{m.spectate_window_current()}</span>
      <span>+{formatSeconds(windowSeconds)}</span>
    </div>
    <div ref={scroll} id="spectate-telemetry-channels" role="tabpanel" aria-labelledby={`spectate-category-${category}`} data-spectate-scroll className="min-h-0 flex-1 overflow-y-auto px-4">
      <div className="sticky top-0 z-10 bg-app-bg">
        {channels.filter((channel) => channel.derived === "delta").map((channel) => (
          <ChartRow key={channel.id} channel={channel} windowSeconds={windowSeconds} controller={controller} snapshot={snapshot} convert={convert} single={!pair.b} />
        ))}
      </div>
      {category === "fuel" && hasERSModeData && <ERSModeChartRow windowSeconds={windowSeconds} controller={controller} snapshot={snapshot} single={!pair.b} />}
      {categorized.filter(({ category: item }) => item === category).map(({ channel }) => (
        <ChartRow key={`${channel.id}:${channel.components[0]?.key}`} channel={channel} windowSeconds={windowSeconds} controller={controller} snapshot={snapshot} convert={convert}
          single={!pair.b} groupComponents={!pair.b && isFourWheelChannel(channel)} />
      ))}
    </div>
  </div>
); }
