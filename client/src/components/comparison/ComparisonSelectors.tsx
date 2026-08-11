import type { LapMeta } from "@shared/racing/sessions/types";
import { Sparkles } from "lucide-react";
import { isEligibilityUsable, resolveEligibilityDecision } from "@shared/racing/quality/policies";
import { lapStatusLabel } from "@/components/LapStatus";
import { LapQualityBadge, localizedEligibilityDecisionText } from "@/components/LapQualityBadge";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

type TrackGroup = { trackOrdinal: number; trackName: string; laps: LapMeta[] };

export function ComparisonSelectors({
  trackGroups,
  selectedTrack,
  setSelectedTrack,
  carAOrd,
  setCarAOrd,
  carBOrd,
  setCarBOrd,
  lapAId,
  setLapAId,
  lapBId,
  setLapBId,
  trackCars,
  carNames,
  carALaps,
  carBLaps,
  comparisonReady,
  aiPanelOpen,
  toggleAiPanel,
}: {
  trackGroups: TrackGroup[];
  selectedTrack: number | null;
  setSelectedTrack: (value: number | null) => void;
  carAOrd: number | null;
  setCarAOrd: (value: number | null) => void;
  carBOrd: number | null;
  setCarBOrd: (value: number | null) => void;
  lapAId: number | null;
  setLapAId: (value: number | null) => void;
  lapBId: number | null;
  setLapBId: (value: number | null) => void;
  trackCars: number[];
  carNames: Map<number, string>;
  carALaps: LapMeta[];
  carBLaps: LapMeta[];
  comparisonReady: boolean;
  aiPanelOpen: boolean;
  toggleAiPanel: () => void;
}) {
  const selectedLapA = carALaps.find((lap) => lap.id === lapAId);
  const selectedLapB = carBLaps.find((lap) => lap.id === lapBId);
  const analysisDecisions = {
    lapA: selectedLapA ? resolveEligibilityDecision(selectedLapA, "corner-trace") : undefined,
    lapB: selectedLapB ? resolveEligibilityDecision(selectedLapB, "corner-trace") : undefined,
  };
  const analysisUsable = isEligibilityUsable(analysisDecisions.lapA) && isEligibilityUsable(analysisDecisions.lapB);
  return (
    <div className="flex shrink-0 flex-wrap items-end gap-3">
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[140px] @sm/workspace:flex-1 @3xl/workspace:max-w-[260px]">
        <label htmlFor="compare-track" className="text-app-caption text-app-text-muted uppercase tracking-wider">
          {m.label_track()}
        </label>
        <SearchSelect
          id="compare-track"
          value={selectedTrack != null ? String(selectedTrack) : ""}
          onChange={(v) => setSelectedTrack(v ? Number(v) : null)}
          options={trackGroups.map((g) => ({ value: String(g.trackOrdinal), label: `${g.trackName} (${g.laps.length} ${m.pitwindow_laps()})` }))}
          placeholder={m.compare_search_tracks()}
        />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "var(--comparison-lap-a)" }} />
          <label htmlFor="compare-car-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_car_a()}
          </label>
        </div>
        <SearchSelect
          id="compare-car-a"
          value={carAOrd != null ? String(carAOrd) : ""}
          onChange={(v) => setCarAOrd(v ? Number(v) : null)}
          options={trackCars.map((ord) => ({ value: String(ord), label: carNames.get(ord) || `${m.compare_car_fallback()} ${ord}` }))}
          placeholder={m.compare_search_cars()}
          disabled={!selectedTrack}
          focusColor="orange-500"
        />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[200px]">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="compare-lap-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_lap_a()}
          </label>
          {selectedLapA && <LapQualityBadge lap={selectedLapA} policyId="corner-trace" />}
        </div>
        <SearchSelect
          id="compare-lap-a"
          value={lapAId != null ? String(lapAId) : ""}
          onChange={(v) => setLapAId(v ? Number(v) : null)}
          options={carALaps.map((lap) => ({
            value: String(lap.id),
            label: [`${m.compare_lap_label()} ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}`, lapStatusLabel(lap, "issues")].filter(Boolean).join(" · "),
          }))}
          placeholder={m.compare_search_laps()}
          disabled={!carAOrd}
          focusColor="orange-500"
        />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "var(--comparison-lap-b)" }} />
          <label htmlFor="compare-car-b" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_car_b()}
          </label>
        </div>
        <SearchSelect
          id="compare-car-b"
          value={carBOrd != null ? String(carBOrd) : ""}
          onChange={(v) => setCarBOrd(v ? Number(v) : null)}
          options={trackCars.map((ord) => ({ value: String(ord), label: carNames.get(ord) || `${m.compare_car_fallback()} ${ord}` }))}
          placeholder={m.compare_search_cars()}
          disabled={!selectedTrack}
          focusColor="blue-500"
        />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[200px]">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="compare-lap-b" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_lap_b()}
          </label>
          {selectedLapB && <LapQualityBadge lap={selectedLapB} policyId="corner-trace" />}
        </div>
        <SearchSelect
          id="compare-lap-b"
          value={lapBId != null ? String(lapBId) : ""}
          onChange={(v) => setLapBId(v ? Number(v) : null)}
          options={carBLaps.map((lap) => ({
            value: String(lap.id),
            label: [`${m.compare_lap_label()} ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}`, lapStatusLabel(lap, "issues")].filter(Boolean).join(" · "),
          }))}
          placeholder={m.compare_search_laps()}
          disabled={!carBOrd}
          focusColor="blue-500"
        />
      </div>
      <div className="ml-auto flex w-full flex-col gap-1 self-end @3xl/workspace:w-auto">
        <Button
          variant="app-outline"
          size="app-lg"
          onClick={toggleAiPanel}
          disabled={!comparisonReady || !analysisUsable}
          title={
            !analysisUsable
              ? [
                  { label: m.compare_lap_a(), decision: analysisDecisions.lapA },
                  { label: m.compare_lap_b(), decision: analysisDecisions.lapB },
                ]
                  .filter(({ decision }) => !isEligibilityUsable(decision))
                  .map(({ label, decision }) => `${label}: ${localizedEligibilityDecisionText(decision)}`)
                  .join(" ")
              : m.compare_toggle_ai()
          }
          className={`w-full @3xl/workspace:w-auto ${aiPanelOpen ? "text-app-accent border-app-accent/40 bg-app-accent/10" : "hover:text-app-accent"}`}
        >
          <Sparkles className="size-3.5" />
          {m.label_ai_analysis()}
        </Button>
      </div>
    </div>
  );
}
