import { useState } from "react";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { ToggleGroup03 } from "@/components/shadcn-studio/toggle-group/toggle-group-03";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

function lapLabel(lap: LapMeta) {
  const processing = lap.processing.state === "queued" ? m.recording_processing_queued()
    : lap.processing.state === "processing" ? m.recording_processing_running()
      : lap.processing.state === "failed" ? m.recording_processing_failed({ error: lap.processing.error })
        : null;
  return `${m.compare_lap_label()} ${lap.lapNumber} — ${formatLapTime(lap.lapTime)} — ${lap.ownership === "others" ? m.import_ownership_others() : m.import_ownership_mine()}${!lap.isValid ? " (inv)" : ""}${processing ? ` · ${processing}` : ""}`;
}

export function ComparisonLapSelect({ id, label, lapId, laps, onChange, disabled, className }: {
  id: string;
  label: string;
  lapId: number | null;
  laps: LapMeta[];
  onChange: (id: number | null) => void;
  disabled: boolean;
  className?: string;
}) {
  const [ownership, setOwnership] = useState("all");
  const selectedLap = laps.find((lap) => lap.id === lapId);
  const visibleLaps = laps.filter((lap) => ownership === "all" || (lap.ownership === "others" ? "others" : "mine") === ownership);
  const selectedVisible = visibleLaps.some((lap) => lap.id === lapId);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <SearchSelect id={id} ariaLabel={label} value={selectedVisible ? String(lapId) : ""}
        onChange={(value) => onChange(value ? Number(value) : null)}
        options={visibleLaps.map((lap) => ({ value: String(lap.id), label: lapLabel(lap), disabled: lap.processing.state !== "ready" }))}
        popupHeader={
          <ToggleGroup03 ariaLabel={label}
            value={ownership} onValueChange={setOwnership}
            options={[
              { value: "all", label: m.browser_all() },
              { value: "mine", label: m.import_ownership_mine() },
              { value: "others", label: m.import_ownership_others() },
            ]} />
        }
        disabled={disabled} placeholder={m.compare_search_laps()} className={className ?? "w-full"} />
      {selectedLap && !selectedVisible && <span className="text-app-caption text-app-text-muted">{m.import_selected()}: {lapLabel(selectedLap)}</span>}
    </div>
  );
}
