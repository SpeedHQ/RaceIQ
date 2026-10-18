import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { getTelemetryVariable, isTelemetryVariableId } from "@raceiq/shared/telemetry/catalog/query";
import { useUnits } from "@/hooks/useUnits";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { channelValue, buildSpectateChannels, type SpectateChannel } from "./spectate-channels";
import type { SpectateController, SpectatePair, SpectateReading, SpectateSnapshot } from "./types";
const A_COLOR = "var(--comparison-lap-a)";
const B_COLOR = "var(--comparison-lap-b)";

type Category = "inputs" | "motion" | "engine" | "fuel" | "tires" | "suspension" | "brakes" | "other";
const CATEGORY_LABELS: Record<Category, () => string> = {
  inputs: m.overlay_inputs, motion: m.analyse_section_dynamics, engine: m.label_engine, fuel: m.label_fuel,
  tires: m.label_tires, suspension: m.chart_suspension, brakes: m.spectate_brake, other: m.analyse_other_group,
};
const WINDOW_STORAGE_KEY = "spectate-chart-window-seconds";
function readWindowSeconds(): 5 | 10 {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(WINDOW_STORAGE_KEY) === "5" ? 5 : 10; }
  catch { return 10; }
}
function classify(channel: SpectateChannel): Category {
  const meta = isTelemetryVariableId(channel.id) ? getTelemetryVariable(channel.id) : undefined;
  const id = meta?.id ?? channel.id;
  const groupId = meta?.parentId ?? "";
  if (id.startsWith("inputs.")) return "inputs";
  if (id.startsWith("motion.") || channel.derived === "g-force" || channel.derived === "balance") return "motion";
  if (groupId.startsWith("engine") || id.startsWith("engine.")) return "engine";
  if (groupId.startsWith("fuel") || id.startsWith("fuel.")) return "fuel";
  if (groupId.startsWith("tires") || groupId.startsWith("wheels") || id.startsWith("tires.") || id.startsWith("tyres.") || id.startsWith("wheels.") || channel.derived === "grip" || channel.derived === "wear-rate") return "tires";
  if (groupId.startsWith("suspension") || id.startsWith("suspension.") || channel.derived === "compression-bias") return "suspension";
  if (groupId.startsWith("brakes") || id.startsWith("brakes.")) return "brakes";
  return "other";
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
}: {
  channel: SpectateChannel;
  windowSeconds: 5 | 10;
  controller: SpectateController;
  snapshot: SpectateSnapshot;
  convert: (id: string, value: number) => number;
}) {
  const locale = getLocale();
  const formatSeconds = useMemo(() => new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "narrow", maximumFractionDigits: 0 }).format, [locale]);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
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
    const vals = points.flatMap(({ a, b }) => (channel.derived === "delta" ? [value(a, channel, "a")] : [value(a, channel, "a"), value(b, channel, "b")])).filter((v): v is number => v !== null);
    const min = vals.length ? Math.min(...vals) : -1;
    const max = vals.length ? Math.max(...vals) : 1;
    const span = max - min || 1;
    const left = 35,
      right = width - 6,
      top = 13,
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
    for (const [side, color] of [
      ["a", A_COLOR],
      ["b", B_COLOR],
    ] as const) {
      if (channel.derived === "delta" && side === "b") continue;
      ctx.strokeStyle = channel.derived === "delta" ? "var(--delta-focus)" : color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let active = false;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const reading = side === "a" ? p.a : p.b;
        const previous = i ? (side === "a" ? points[i - 1].a : points[i - 1].b) : null;
        const v = value(reading, channel, side);
        const pv = value(previous, channel, side);
        if (v === null) {
          active = false;
          continue;
        }
        const x = left + ((p.time - snapshot.time + windowSeconds) / (windowSeconds * 2)) * (right - left);
        if (active) {
          if (channel.id === "inputs.gear" && pv !== null) {
            ctx.lineTo(x, y(pv!));
            ctx.lineTo(x, y(v));
          } else ctx.lineTo(x, y(v));
        } else {
          ctx.moveTo(x, y(v));
          active = true;
        }
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = "var(--app-text-muted)";
    ctx.font = "var(--text-app-nano) var(--font-mono)";
    ctx.textAlign = "left";
    ctx.fillText(`−${formatSeconds(windowSeconds)}`, left, 9);
    ctx.textAlign = "center";
    ctx.fillText(formatSeconds(0), (left + right) / 2, 9);
    ctx.textAlign = "right";
    ctx.fillText(`+${formatSeconds(windowSeconds)}`, right, 9);
  }, [visible, points, channel, convert, width, windowSeconds, snapshot.time]);
  const nowA = value(snapshot.a, channel, "a");
  const nowB = channel.derived === "delta" ? null : value(snapshot.b, channel, "b");
  const label = channel.label + (channel.components[0]?.label ? ` ${channel.components[0].label}` : "");
  return (
    <div
      ref={root}
      data-channel-id={channel.id}
      data-component={channel.components[0]?.key ?? ""}
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
          <span style={{ color: A_COLOR }}>{format(nowA)}</span>
          <span style={{ color: B_COLOR }}>{format(nowB)}</span>
        </span>
      </div>
      <canvas
        ref={canvas}
        className="block h-[72px] w-full"
        role="img"
        aria-label={`${label}; A ${format(nowA)}, B ${format(nowB)}`}
        data-current-a={format(nowA)}
        data-current-b={format(nowB)}
        title={snapshot.b ? m.spectate_b_sampled_at_time({ time: snapshot.b.time.toFixed(2) }) : m.spectate_b_unavailable()}
      />
      {snapshot.b && snapshot.a && snapshot.b.time !== snapshot.a.time && (
        <div className="text-right text-app-micro text-app-text-dim">{m.spectate_b_sampled_at_time({ time: snapshot.b.time.toFixed(2) })}</div>
      )}
    </div>
  );
  function value(reading: SpectateReading | null, source: SpectateChannel, side: "a" | "b"): number | null {
    const raw = channelValue(reading, source, source.components[0]?.key ?? "", side);
    return raw === null ? null : source.derived ? raw : convert(source.id, raw);
  }
}

function format(value: number | null): string {
  return value === null ? "—" : Number.isFinite(value) ? value.toFixed(2) : "—";
}

export function SpectateTelemetryPanel({ pair, controller, onClose }: { pair: SpectatePair; controller: SpectateController; onClose: () => void }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const units = useUnits(pair.gameId);
  const channels = useMemo(
    () =>
      buildSpectateChannels(pair).flatMap((channel) =>
        channel.components.map((component) => ({
          ...channel,
          label:
            channel.derived === "g-force"
              ? m.spectate_g_force()
              : channel.derived === "balance"
                ? m.spectate_balance()
                : channel.derived === "grip"
                  ? m.spectate_grip_demand()
                  : channel.derived === "compression-bias"
                    ? m.analyse_suspension_compression_bias()
                    : channel.derived === "wear-rate"
                      ? m.analyse_wheels_wear_s()
                      : channel.derived === "delta"
                        ? m.spectate_time_delta()
                        : channel.label,
          unit: channel.id === "motion.speed" ? units.speedLabel : channel.unit === "°C" || channel.unit === "C" ? units.tempLabel : channel.unit,
          components: [{ ...component, label: channel.derived === "compression-bias" ? (component.key === "front" ? m.analyse_suspension_front() : m.analyse_suspension_left()) : component.label }],
        })),
      ),
    [pair, units.speedLabel, units.tempLabel],
  );
  const [windowSeconds, setWindowSeconds] = useState<5 | 10>(readWindowSeconds);
  useEffect(() => {
    try { localStorage.setItem(WINDOW_STORAGE_KEY, String(windowSeconds)); } catch { /* storage unavailable */ }
  }, [windowSeconds]);
  const [category, setCategory] = useState<Category | "all">("all");
  const categorized = useMemo(() => channels.map((channel) => ({ channel, category: classify(channel) })), [channels]);
  const presentCategories = useMemo(() => (["inputs", "motion", "engine", "fuel", "tires", "suspension", "brakes", "other"] as const)
    .filter((item) => categorized.some(({ category: itemCategory }) => itemCategory === item)), [categorized]);
  useEffect(() => {
    if (category !== "all" && !presentCategories.includes(category)) setCategory("all");
  }, [category, presentCategories]);
  useEffect(() => setCategory("all"), [pair.gameId, pair.comparison.lapA.id, pair.comparison.lapB.id]);
  const tabs = useMemo(() => ["all", ...presentCategories] as const, [presentCategories]);
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
    <div className="h-full w-full min-h-0 min-w-0 flex-1 flex flex-col bg-app-surface">
      <header className="flex items-center justify-between px-4 py-3 text-app-label">
        <strong className="font-medium text-app-text">{m.spectate_telemetry()}</strong>
        <button type="button" className="text-app-text-secondary hover:text-app-accent" onClick={onClose} aria-label={m.spectate_collapse_telemetry()}>
          {m.spectate_collapse_telemetry()}
        </button>
      </header>
      <div className="flex items-center justify-between gap-2 px-3 pb-2 text-app-micro">
        <div className="flex gap-1" role="group" aria-label={m.review_range()}>
          {([5, 10] as const).map((seconds) => (
            <button key={seconds} type="button" aria-pressed={windowSeconds === seconds} onClick={() => setWindowSeconds(seconds)}
              className={`rounded px-2 py-1 ${windowSeconds === seconds ? "bg-app-accent text-app-on-filled" : "text-app-text-muted"}`}>
              ±{formatSeconds(seconds)}
            </button>
          ))}
        </div>
        <span className="text-app-text-muted">{m.review_range()}</span>
      </div>
      <div role="tablist" aria-label={m.label_category()} className="flex gap-1 overflow-x-auto px-3 pb-2">
        {tabs.map((item) => (
          <button key={item} type="button" role="tab" aria-selected={category === item} tabIndex={category === item ? 0 : -1}
            id={`spectate-category-${item}`} aria-controls="spectate-telemetry-channels"
            onClick={() => setCategory(item)} onKeyDown={onTabKeyDown}
            className={`shrink-0 rounded px-2 py-1 text-app-micro ${category === item ? "bg-app-accent text-app-on-filled" : "text-app-text-secondary"}`}>
            {item === "all" ? m.browser_all() : CATEGORY_LABELS[item]()}
          </button>
        ))}
      </div>
      <div className="flex justify-between px-4 pb-2 text-app-micro text-app-text-muted">
        <span>{formatSeconds(-windowSeconds)}</span>
        <span>{m.spectate_window_current()}</span>
        <span>+{formatSeconds(windowSeconds)}</span>
      </div>
      <div ref={scroll} id="spectate-telemetry-channels" role="tabpanel" aria-labelledby={`spectate-category-${category}`} data-spectate-scroll className="min-h-0 flex-1 overflow-y-auto px-4">
        {categorized.filter(({ category: item }) => category === "all" || item === category).map(({ channel }) => (
          <ChartRow key={`${channel.id}:${channel.components[0]?.key}`} channel={channel} windowSeconds={windowSeconds} controller={controller} snapshot={snapshot} convert={convert} />
        ))}
      </div>
    </div>
  );
}
