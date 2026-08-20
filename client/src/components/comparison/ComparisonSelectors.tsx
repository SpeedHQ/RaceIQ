import type { LapMeta } from "@shared/racing/sessions/types";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchMultiSelect } from "@/components/ui/SearchMultiSelect";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { COMPARISON_COLOR_VARS } from "@/lib/colors";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

export function buildComparisonLapOption(lap: LapMeta, locale?: "en" | "de") {
  return {
    value: String(lap.id),
    label: `${m.compare_lap_label({}, { locale })} ${lap.lapNumber} — ${formatLapTime(lap.lapTime)} — ${lap.ownership === "others" ? m.import_ownership_others({}, { locale }) : m.import_ownership_mine({}, { locale })}${!lap.isValid ? " (inv)" : ""}`,
  };
}

type TrackGroup = { trackOrdinal: number; trackName: string; laps: LapMeta[] };

export function ComparisonSelectors({
  trackGroups,
  selectedTrack,
  setSelectedTrack,
  carAOrd,
  setCarAOrd,
  lapAId,
  setLapAId,
  comparisonLapIds,
  toggleComparisonLap,
  clearComparisonLaps,
  trackCars,
  carNames,
  referenceLaps,
  comparisonLaps,
  comparisonReady,
  aiPanelOpen,
  toggleAiPanel,
}: {
  trackGroups: TrackGroup[];
  selectedTrack: number | null;
  setSelectedTrack: (value: number | null) => void;
  carAOrd: number | null;
  setCarAOrd: (value: number | null) => void;
  lapAId: number | null;
  setLapAId: (value: number | null) => void;
  comparisonLapIds: number[];
  toggleComparisonLap: (lapId: number) => void;
  clearComparisonLaps: () => void;
  trackCars: number[];
  carNames: Map<number, string>;
  referenceLaps: LapMeta[];
  comparisonLaps: LapMeta[];
  comparisonReady: boolean;
  aiPanelOpen: boolean;
  toggleAiPanel: () => void;
}) {
  const comparisonOptions = comparisonLaps.map((lap) => {
    const option = buildComparisonLapOption(lap);
    const carName = lap.carOrdinal == null ? m.compare_car_fallback() : carNames.get(lap.carOrdinal) || `${m.compare_car_fallback()} ${lap.carOrdinal}`;
    return { key: lap.id, label: `${carName} — ${option.label}`, search: `${carName} ${option.label}` };
  });

  return (
    <div className="flex shrink-0 flex-wrap items-end gap-3">
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[140px] @sm/workspace:flex-1 @3xl/workspace:max-w-[260px]">
        <label htmlFor="compare-track" className="text-app-caption text-app-text-muted uppercase tracking-wider">
          {m.label_track()}
        </label>
        <SearchSelect
          id="compare-track"
          value={selectedTrack != null ? String(selectedTrack) : ""}
          onChange={(value) => setSelectedTrack(value ? Number(value) : null)}
          options={trackGroups.map((group) => ({ value: String(group.trackOrdinal), label: `${group.trackName} (${group.laps.length} ${m.pitwindow_laps()})` }))}
          placeholder={m.compare_search_tracks()}
        />
      </div>

      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
        <div className="flex items-center gap-1.5">
          <div className="size-2.5 rounded-full" style={{ backgroundColor: COMPARISON_COLOR_VARS[0] }} />
          <label htmlFor="compare-car-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_reference_car()}
          </label>
        </div>
        <SearchSelect
          id="compare-car-a"
          value={carAOrd != null ? String(carAOrd) : ""}
          onChange={(value) => setCarAOrd(value ? Number(value) : null)}
          options={trackCars.map((ordinal) => ({ value: String(ordinal), label: carNames.get(ordinal) || `${m.compare_car_fallback()} ${ordinal}` }))}
          placeholder={m.compare_search_cars()}
          disabled={!selectedTrack}
          focusColor="orange-500"
        />
      </div>

      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
        <label htmlFor="compare-lap-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">
          {m.compare_reference_lap()}
        </label>
        <div className="flex items-center gap-2">
          <SearchSelect
            id="compare-lap-a"
            value={lapAId != null ? String(lapAId) : ""}
            onChange={(value) => setLapAId(value ? Number(value) : null)}
            options={referenceLaps.map((lap) => buildComparisonLapOption(lap))}
            placeholder={m.compare_search_laps()}
            disabled={!carAOrd}
            focusColor="orange-500"
          />
          {lapAId != null && (
            <span className="shrink-0 rounded border border-app-border px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-app-text-muted">
              {referenceLaps.find((lap) => lap.id === lapAId)?.ownership === "others" ? m.import_ownership_others() : m.import_ownership_mine()}
            </span>
          )}
        </div>
      </div>

      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:min-w-[220px] @sm/workspace:flex-[2] @3xl/workspace:max-w-[360px]">
        <span className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.compare_comparison_laps()}</span>
        <SearchMultiSelect<number>
          buttonLabel={comparisonLapIds.length === 0 ? m.compare_select_laps() : m.compare_laps_selected({ count: comparisonLapIds.length })}
          options={comparisonOptions}
          isSelected={(lapId) => comparisonLapIds.includes(lapId)}
          onSelect={toggleComparisonLap}
          onClear={comparisonLapIds.length > 0 ? clearComparisonLaps : undefined}
          searchPlaceholder={m.compare_search_laps()}
          disabled={lapAId == null}
          className="w-full"
          menuWidthClass="w-[min(28rem,var(--available-width))]"
          renderItem={(option, selected) => {
            const selectedIndex = comparisonLapIds.indexOf(option.key);
            const colorIndex = selectedIndex >= 0 ? selectedIndex + 1 : comparisonLapIds.length + 1;
            return (
              <>
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: COMPARISON_COLOR_VARS[colorIndex % COMPARISON_COLOR_VARS.length] }} />
                <span className="truncate">{option.label}</span>
                {selected && <span className="sr-only">{m.trackdetail_selected()}</span>}
              </>
            );
          }}
        />
      </div>

      <div className="ml-auto flex w-full flex-col gap-1 self-end @3xl/workspace:w-auto">
        <Button
          variant="app-outline"
          size="app-lg"
          onClick={toggleAiPanel}
          disabled={!comparisonReady}
          title={comparisonReady ? m.compare_toggle_ai() : m.compare_ai_requires_loaded_laps()}
          className={`w-full @3xl/workspace:w-auto ${aiPanelOpen ? "text-app-accent border-app-accent/40 bg-app-accent/10" : "hover:text-app-accent"}`}
        >
          <Sparkles className="size-3.5" />
          {m.label_ai_analysis()}
        </Button>
      </div>
    </div>
  );
}
