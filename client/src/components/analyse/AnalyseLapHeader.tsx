import { ChevronDown, Download, FileDown, NotebookPen, Sparkles, Trash2, Upload } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { LapMeta } from "../../../../shared/racing/sessions/types";
import { formatLapTime } from "../../lib/format";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";
import { SearchSelect } from "../ui/SearchSelect";

export function buildAnalyseLapOption(lap: LapMeta, locale?: "en" | "de") {
  return {
    value: String(lap.id),
    label: `Lap ${lap.lapNumber} – ${formatLapTime(lap.lapTime)} — ${lap.ownership === "others" ? m.import_ownership_others({}, { locale }) : m.import_ownership_mine({}, { locale })}${!lap.isValid ? " ✕" : ""}`,
  };
}
import { DropdownMenu } from "../ui/DropdownMenu";
import { NoteModal } from "../ui/NoteModal";
import { DataGuideModal } from "./DataGuideModal";
interface Props {
  // Selection state
  selectedTrack: number | null;
  selectedCar: number | null;
  selectedLapId: number | null;
  selectedLap: LapMeta | undefined;
  trackNames: Record<number, string>;
  carNames: Record<number, string>;
  tracks: [number, number][];
  carsForTrack: [number, number][];
  filteredLaps: LapMeta[];
  // Tune state
  hasTelemetry: boolean;
  hasF1Setup: boolean;
  availableTunes: { id: number; name: string }[] | undefined;
  tunePending: boolean;
  // UI state
  loading: boolean;
  aiPanelOpen: boolean;
  exportingBin: boolean;
  // Callbacks
  onTrackChange: (v: number | null) => void;
  onCarChange: (v: number | null) => void;
  onLapChange: (v: number | null) => void;
  onTuneChange: (tuneId: number | null) => void;
  onViewTune: (tuneId: number) => void;
  onShowSetup: () => void;
  onExport: () => void;
  onExportBin: () => void;
  onImportSession: () => void;
  onToggleAi: () => void;
  onDeleteLap: () => void;
  onNotesChange: (notes: string) => void;
}

export const AnalyseLapHeader = memo(function AnalyseLapHeader({
  selectedTrack,
  selectedCar,
  selectedLapId,
  selectedLap,
  trackNames,
  carNames,
  tracks,
  carsForTrack,
  filteredLaps,
  hasTelemetry,
  hasF1Setup,
  availableTunes,
  tunePending,
  loading,
  aiPanelOpen,
  exportingBin,
  onTrackChange,
  onCarChange,
  onLapChange,
  onTuneChange,
  onViewTune,
  onShowSetup,
  onExport,
  onExportBin,
  onImportSession,
  onToggleAi,
  onDeleteLap,
  onNotesChange,
}: Props) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const trackOptions = useMemo(() => tracks.map(([ordinal, count]) => ({ value: String(ordinal), label: `${trackNames[ordinal] || `Track ${ordinal}`} (${count})` })), [trackNames, tracks]);
  const carOptions = useMemo(() => carsForTrack.map(([ordinal, count]) => ({ value: String(ordinal), label: `${carNames[ordinal] || `Car ${ordinal}`} (${count})` })), [carNames, carsForTrack]);
  const lapOptions = useMemo(() => {
    const sessions = new Map<number, LapMeta[]>();
    for (const lap of filteredLaps) {
      const sessionLaps = sessions.get(lap.sessionId);
      if (sessionLaps) sessionLaps.push(lap);
      else sessions.set(lap.sessionId, [lap]);
    }
    return filteredLaps.map((lap) => {
      const sessionLaps = sessions.get(lap.sessionId) ?? [lap];
      const sessionDate = new Date(sessionLaps[sessionLaps.length - 1].createdAt);
      const sessionLabel = `Session · ${sessionDate.toLocaleDateString()} ${sessionDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${sessionLaps.length} lap${sessionLaps.length !== 1 ? "s" : ""}`;
      return { ...buildAnalyseLapOption(lap), group: sessionLabel };
    });
  }, [filteredLaps]);
  return (
    <>
      <div className="flex items-center gap-2 p-3 border-b border-app-border flex-wrap shrink-0">
        {/* Track selector */}
        <SearchSelect
          value={selectedTrack != null ? String(selectedTrack) : ""}
          onChange={(v) => onTrackChange(v ? Number(v) : null)}
          options={trackOptions}
          placeholder={m.analyse_search_tracks_placeholder()}
          className="w-full min-w-0 @3xl/workspace:w-auto @3xl/workspace:min-w-[200px] @3xl/workspace:flex-1 @5xl/workspace:flex-none"
          fallbackLabel={selectedTrack != null ? trackNames[selectedTrack] || `Track ${selectedTrack}` : undefined}
        />

        {/* Car selector */}
        <SearchSelect
          value={selectedCar != null ? String(selectedCar) : ""}
          onChange={(v) => onCarChange(v ? Number(v) : null)}
          options={carOptions}
          placeholder={m.analyse_search_cars_placeholder()}
          disabled={selectedTrack == null}
          className="w-full min-w-0 @3xl/workspace:w-auto @3xl/workspace:min-w-[200px] @3xl/workspace:flex-1 @5xl/workspace:flex-none"
          fallbackLabel={selectedCar != null ? carNames[selectedCar] || `Car ${selectedCar}` : undefined}
        />

        <div className="flex items-center gap-2">
          <SearchSelect
            value={selectedLapId != null ? String(selectedLapId) : ""}
            onChange={(v) => onLapChange(v ? Number(v) : null)}
            options={lapOptions}
            placeholder={m.analyse_search_laps_placeholder()}
            disabled={selectedCar == null}
            className="w-full min-w-0 @3xl/workspace:w-auto @3xl/workspace:min-w-[160px] @3xl/workspace:flex-1 @5xl/workspace:flex-none"
            fallbackLabel={selectedLapId != null ? `Lap ${selectedLapId}` : undefined}
          />
          {selectedLapId != null && (
            <span className="shrink-0 rounded border border-app-border px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-app-text-muted">
              {selectedLap?.ownership === "others" ? m.import_ownership_others() : m.import_ownership_mine()}
            </span>
          )}
        </div>

        {/* Tune / setup controls.
          F1 25 laps capture the full car setup on-packet, surfaced via the
          Car Setup modal — the Forza-style tune picker doesn't apply there,
          so we hide it and render only the Car Setup button. */}
        {selectedLapId && hasTelemetry && (
          <div className="flex items-center gap-2 text-sm">
            {hasF1Setup ? (
              <Button variant="app-outline" size="app-md" onClick={onShowSetup}>
                {m.analyse_car_setup_button()}
              </Button>
            ) : (
              <>
                <span className="text-app-text-muted">{m.analyse_tune_label()}</span>
                <SearchSelect
                  value={selectedLap?.tuneId != null ? String(selectedLap.tuneId) : ""}
                  onChange={(value) => onTuneChange(value ? Number.parseInt(value, 10) : null)}
                  options={availableTunes?.map((tune) => ({ value: String(tune.id), label: tune.name })) ?? []}
                  placeholder={m.analyse_no_tune()}
                  ariaLabel={m.analyse_tune_label()}
                  disabled={tunePending}
                  className="min-w-[160px]"
                />
                {selectedLap?.tuneId != null && (
                  <Button variant="app-outline" size="app-sm" onClick={() => onViewTune(selectedLap.tuneId as number)}>
                    {m.label_view()}
                  </Button>
                )}
                {tunePending && <span className="text-xs text-app-text-muted animate-pulse">{m.common_saving()}</span>}
              </>
            )}
          </div>
        )}

        {noteOpen && (
          <NoteModal
            value={selectedLap?.notes}
            onSave={(v) => {
              onNotesChange(v);
              setNoteOpen(false);
            }}
            onClose={() => setNoteOpen(false)}
          />
        )}
        <div className="flex w-full flex-wrap items-center gap-2 @3xl/workspace:ml-auto @3xl/workspace:w-auto">
          {selectedLapId != null && (
            <Button
              variant="app-outline"
              size="app-md"
              onClick={() => setNoteOpen(true)}
              className={selectedLap?.notes ? "text-app-accent border-app-accent/40" : ""}
              title={selectedLap?.notes || m.analyse_add_notes_button()}
            >
              <NotebookPen className="size-3.5" />
              {selectedLap?.notes ? m.analyse_notes_button() : m.analyse_add_notes_button()}
            </Button>
          )}
          {selectedLapId != null && (
            <Button variant="destructive-outline" size="app-md" onClick={onDeleteLap}>
              <Trash2 className="size-3.5" />
              {m.common_delete()}
            </Button>
          )}
          {hasTelemetry && (
            <Button variant="app-outline" size="app-md" onClick={() => setGuideOpen(true)}>
              {m.analyse_guide_button()}
            </Button>
          )}
          {hasTelemetry && (
            <DropdownMenu
              trigger={
                <Button variant="app-outline" size="app-md" disabled={exportingBin}>
                  {exportingBin ? "Exporting..." : "Export"}
                  <ChevronDown className="size-3.5" />
                </Button>
              }
              items={[
                {
                  key: "export-csv",
                  label: m.analyse_export_csv_button(),
                  icon: <FileDown className="size-3.5" />,
                  onClick: onExport,
                },
                ...(selectedLapId != null
                  ? [
                      {
                        key: "export-bin",
                        label: "Export .bin",
                        icon: <Download className="size-3.5" />,
                        onClick: onExportBin,
                        disabled: exportingBin,
                      },
                    ]
                  : []),
              ]}
            />
          )}
          <Button variant="app-outline" size="app-md" onClick={onImportSession}>
            <Upload className="size-3.5" />
            {m.sessions_import()}
          </Button>
          {hasTelemetry && (
            <Button variant={aiPanelOpen ? "selected-toggle" : "app-outline"} size="app-lg" onClick={onToggleAi}>
              <Sparkles className="size-3.5" />
              {m.label_ai_analysis()}
            </Button>
          )}
          {loading && <span className="text-xs text-app-text-muted animate-pulse">{m.common_loading()}</span>}
        </div>
      </div>
      {guideOpen && <DataGuideModal onClose={() => setGuideOpen(false)} />}
    </>
  );
});
