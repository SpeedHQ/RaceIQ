import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { ChartRange } from "@/lib/chart-range";
import { useEffect, useMemo, useState } from "react";
import { TelemetryChart } from "@/components/TelemetryChart";
import { TimeDelta } from "@/components/TimeDelta";
import { LoadingIndicator } from "@/components/LoadingIndicator";
import { COLOR_A, COLOR_B } from "@/lib/comparison-utils";
import { prepareSpectateLap, sampleLap } from "@raceiq/lap-replay/ui"
import { useLapSemanticTelemetry } from "@/hooks/laps";
import type { useUnits } from "@/hooks/useUnits";
import { useGameId } from "@/stores/game";
import { buildSpectateChannels, channelValue } from "@raceiq/lap-replay/ui"
import { CATEGORY_LABELS, classify, type Category } from "@raceiq/lap-replay/ui"
import { m } from "@/paraglide/messages";

export function ComparisonCharts({
  comparison,
  units,
  onCursorMove,
  onRangeSelect,
  visibleRange,
  refining = false,
  onZoomOut,
}: {
  comparison: ComparisonData;
  units: ReturnType<typeof useUnits>;
  onCursorMove: (distance: number | null) => void;
  onRangeSelect?: (start: number, end: number) => void;
  visibleRange: ChartRange | null;
  refining?: boolean;
  onZoomOut?: () => void;
}) {
  const gameId = useGameId();
  const replayA = useLapSemanticTelemetry(comparison.lapA.id);
  const replayB = useLapSemanticTelemetry(comparison.lapB.id);
  const [category, setCategory] = useState<Category>("inputs");
  const pair = useMemo(() => {
    if (!gameId || !replayA.data || !replayB.data) return null;
    return {
      gameId, comparison,
      a: prepareSpectateLap(replayA.data, comparison, "a"),
      b: prepareSpectateLap(replayB.data, comparison, "b"),
    };
  }, [gameId, comparison, replayA.data, replayB.data]);
  const channels = useMemo(() => pair ? buildSpectateChannels(pair)
    .filter((channel) => channel.derived !== "delta")
    .flatMap((channel) => channel.components.map((component) => ({ channel, component })))
    .filter(({ channel, component }) => [pair.a, pair.b].some((lap, index) => lap.samples.some((sample) =>
      channelValue({ ...sample, pose: null }, channel, component.key, index === 0 ? "a" : "b") !== null,
    ))) : [], [pair]);
  const categories = useMemo(() => (Object.keys(CATEGORY_LABELS) as Category[])
    .filter((item) => channels.some(({ channel }) => classify(channel) === item)), [channels]);
  const selectedCategory = categories.includes(category) ? category : categories[0];
  useEffect(() => setCategory("inputs"), [comparison.lapA.id, comparison.lapB.id]);
  const readings = useMemo(() => pair ? {
    a: comparison.traces.elapsedTimeA.map((time) => Number.isFinite(time) ? sampleLap(pair.a, time, false) : null),
    b: comparison.traces.elapsedTimeB.map((time) => Number.isFinite(time) ? sampleLap(pair.b, time, false) : null),
  } : null, [pair, comparison]);
  const charts = useMemo(() => {
    if (!readings) return [];
    return channels.filter(({ channel }) => classify(channel) === selectedCategory).map(({ channel, component }) => {
      const unit = channel.id === "motion.speed" ? units.speedLabel : channel.unit === "°C" || channel.unit === "C" ? units.tempLabel : channel.unit;
      const convert = (value: number | null) => value === null ? NaN : channel.id === "motion.speed" ? units.speed(value) : channel.unit === "°C" || channel.unit === "C" ? units.temp(value) : value;
      const label = channel.derived === "g-force" ? m.spectate_g_force()
        : channel.derived === "balance" ? m.spectate_balance()
        : channel.derived === "grip" ? m.spectate_grip_demand()
        : channel.derived === "compression-bias" ? m.analyse_suspension_compression_bias()
        : channel.derived === "wear-rate" ? m.analyse_wheels_wear_s() : channel.label;
      const componentLabel = channel.derived === "compression-bias" ? (component.key === "front" ? m.analyse_suspension_front() : m.analyse_suspension_left()) : component.label;
      const title = [label, componentLabel, unit ? `(${unit})` : ""].filter(Boolean).join(" ");
      return {
        key: `${channel.id}:${component.key}`, title,
        data: {
          distance: comparison.traces.distance,
          values: [readings.a.map((reading) => convert(channelValue(reading, channel, component.key, "a"))), readings.b.map((reading) => convert(channelValue(reading, channel, component.key, "b")))],
          labels: [`A — ${title}`, `B — ${title}`], colors: [COLOR_A, COLOR_B],
        },
      };
    });
  }, [readings, channels, selectedCategory, units, comparison.traces.distance]);
  const timeDelta = useMemo(() => comparison.timeDelta.map((delta) => -delta), [comparison.timeDelta]);
  const error = replayA.error ?? replayB.error;
  const chartProps = { syncKey: "lap-compare", onCursorMove, onRangeSelect, visibleRange, onZoomOut };
  return (
    <div className="flex h-[42rem] min-h-0 min-w-0 flex-none flex-col gap-4 overflow-hidden @5xl/workspace:h-auto @5xl/workspace:flex-1">
        <div role="tablist" aria-label={m.label_category()} className="flex shrink-0 gap-1 overflow-x-auto">
          {categories.map((item, index) => <button key={item} type="button" role="tab"
            id={`compare-category-${item}`} aria-controls="compare-telemetry-channels"
            aria-selected={selectedCategory === item} tabIndex={selectedCategory === item ? 0 : -1}
            onClick={() => setCategory(item)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % categories.length
                : event.key === "ArrowLeft" ? (index + categories.length - 1) % categories.length
                : event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              setCategory(categories[next]!);
              document.getElementById(`compare-category-${categories[next]}`)?.focus();
            }}
            className={`shrink-0 rounded px-2 py-1 text-app-micro focus-visible:outline-2 focus-visible:outline-app-accent ${selectedCategory === item ? "bg-app-accent text-app-on-filled" : "text-app-text-secondary"}`}>
            {m[CATEGORY_LABELS[item]]()}
          </button>)}
        </div>
      <div data-testid="compare-chart-column" aria-busy={refining} className="min-h-0 flex-1 overflow-y-auto">
        <div data-testid="compare-time-delta" className="sticky top-0 z-20 shrink-0 rounded-lg border border-app-border bg-app-bg p-1">
          <TimeDelta distances={comparison.traces.distance} timeDelta={timeDelta} height={140} title={m.compare_time_delta()} {...chartProps} />
        </div>
      {error ? <div role="alert" className="text-status-danger text-app-detail">
        <p>{m.spectate_replay_failed()} {error.message}</p>
        <button type="button" onClick={() => { void replayA.refetch(); void replayB.refetch(); }} className="underline">{m.spectate_retry()}</button>
      </div> : !pair ? <LoadingIndicator label={m.compare_loading()} /> : <>
        <div id="compare-telemetry-channels" role="tabpanel" aria-labelledby={selectedCategory ? `compare-category-${selectedCategory}` : undefined} data-testid="compare-telemetry-channels" className="mt-4 shrink-0">
          <div className="flex flex-col gap-4">
            {charts.map(({ key, title, data }) => <div key={key} data-channel={key} className="rounded-lg border border-app-border p-1">
              <TelemetryChart data={data} height={180} title={title} {...chartProps} />
            </div>)}
            {!channels.length && <p className="text-app-detail text-status-unavailable">{m.compare_telemetry_unavailable()}</p>}
          </div>
        </div>
      </>}
      </div>
    </div>
  );
}
