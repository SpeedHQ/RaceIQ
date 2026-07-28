import type { LapMeta } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, FileDown, NotebookPen, Sparkles, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { formatLapTime } from "../../lib/format";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";
import { DropdownMenu } from "../ui/DropdownMenu";
import { NoteModal } from "../ui/NoteModal";
import { SearchSelect } from "../ui/SearchSelect";
import { DataGuideModal } from "./DataGuideModal";
import { MotecImportModal } from "./MotecImportModal";

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
  // Callbacks
  onTrackChange: (v: number | null) => void;
  onCarChange: (v: number | null) => void;
  onLapChange: (v: number | null) => void;
  onTuneChange: (tuneId: number | null) => void;
  onViewTune: (tuneId: number) => void;
  onShowSetup: () => void;
  onExport: () => void;
  onExportBin: () => void;
  onImportBin: (file: File) => void;
  exportingBin: boolean;
  importingBin: boolean;
  onToggleAi: () => void;
  onDeleteLap: () => void;
  onNotesChange: (notes: string) => void;
}

export function AnalyseLapHeader({
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
  onTrackChange,
  onCarChange,
  onLapChange,
  onTuneChange,
  onViewTune,
  onShowSetup,
  onExport,
  onExportBin,
  onImportBin,
  exportingBin,
  importingBin,
  onToggleAi,
  onDeleteLap,
  onNotesChange,
}: Props) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [motecOpen, setMotecOpen] = useState(false);
  const queryClient = useQueryClient();
  const [noteOpen, setNoteOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="flex items-center gap-2 p-3 border-b border-app-border flex-wrap shrink-0">
        {/* Track selector */}
        <SearchSelect
          value={selectedTrack != null ? String(selectedTrack) : ""}
          onChange={(v) => onTrackChange(v ? Number(v) : null)}
          options={tracks.map(([ord, count]) => ({ value: String(ord), label: `${trackNames[ord] || `Track ${ord}`} (${count})` }))}
          placeholder={m.analyse_search_tracks_placeholder()}
          className="min-w-[200px]"
          fallbackLabel={selectedTrack != null ? trackNames[selectedTrack] || `Track ${selectedTrack}` : undefined}
        />

        {/* Car selector */}
        <SearchSelect
          value={selectedCar != null ? String(selectedCar) : ""}
          onChange={(v) => onCarChange(v ? Number(v) : null)}
          options={carsForTrack.map(([ord, count]) => ({ value: String(ord), label: `${carNames[ord] || `Car ${ord}`} (${count})` }))}
          placeholder={m.analyse_search_cars_placeholder()}
          disabled={selectedTrack == null}
          className="min-w-[200px]"
          fallbackLabel={selectedCar != null ? carNames[selectedCar] || `Car ${selectedCar}` : undefined}
        />

        {/* Lap selector */}
        <SearchSelect
          value={selectedLapId != null ? String(selectedLapId) : ""}
          onChange={(v) => onLapChange(v ? Number(v) : null)}
          options={filteredLaps.map((lap) => {
            const sessionLaps = filteredLaps.filter((l) => l.sessionId === lap.sessionId);
            const sessionDate = new Date(sessionLaps[sessionLaps.length - 1].createdAt);
            const sessionLabel = `Session · ${sessionDate.toLocaleDateString()} ${sessionDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${sessionLaps.length} lap${sessionLaps.length !== 1 ? "s" : ""}`;
            return {
              value: String(lap.id),
              label: `Lap ${lap.lapNumber} – ${formatLapTime(lap.lapTime)}`,
              group: sessionLabel,
            };
          })}
          placeholder={m.analyse_search_laps_placeholder()}
          disabled={selectedCar == null}
          fallbackLabel={selectedLapId != null ? `Lap ${selectedLapId}` : undefined}
        />

        {/* Tune / setup controls.
          F1 25 laps capture the full car setup on-packet, surfaced via the
          Car Setup modal — the Forza-style tune picker doesn't apply there,
          so we hide it and render only the Car Setup button. */}
        {selectedLapId && hasTelemetry && (
          <div className="flex items-center gap-2 text-sm">
            {hasF1Setup ? (
              <Button variant="app-outline" size="app-sm" onClick={onShowSetup}>
                {m.analyse_car_setup_button()}
              </Button>
            ) : (
              <>
                <span className="text-app-text-muted">{m.analyse_tune_label()}</span>
                <select
                  value={selectedLap?.tuneId ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    onTuneChange(val ? Number.parseInt(val, 10) : null);
                  }}
                  disabled={tunePending}
                  className="bg-app-surface border border-app-border-input rounded px-2 py-1 text-sm text-app-text"
                >
                  <option value="">{m.analyse_no_tune()}</option>
                  {availableTunes?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
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
        <div className="ml-auto flex items-center gap-2">
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
            <Button variant="app-outline" size="app-md" onClick={onDeleteLap} className="text-red-400 border-red-400/30 hover:bg-red-400/10">
              <Trash2 className="size-3.5" />
              {m.common_delete()}
            </Button>
          )}
          {hasTelemetry && (
            <Button variant="app-outline" size="app-md" onClick={() => setGuideOpen(true)}>
              {m.analyse_guide_button()}
            </Button>
          )}
          <input
            ref={importInputRef}
            type="file"
            accept=".bin,.gz,.bin.gz"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImportBin(file);
              e.target.value = "";
            }}
          />
          <DropdownMenu
            trigger={
              <Button variant="app-outline" size="app-md" disabled={exportingBin || importingBin}>
                {exportingBin ? "Exporting..." : importingBin ? "Importing..." : m.analyse_export_import_button()}
                <ChevronDown className="size-3.5" />
              </Button>
            }
            items={[
              ...(hasTelemetry
                ? [
                    {
                      key: "export-csv",
                      label: m.analyse_export_csv_button(),
                      icon: <FileDown className="size-3.5" />,
                      onClick: onExport,
                    },
                  ]
                : []),
              ...(selectedLapId != null && hasTelemetry
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
              {
                key: "import-bin",
                label: "Import .bin",
                icon: <Upload className="size-3.5" />,
                onClick: () => importInputRef.current?.click(),
                disabled: importingBin,
              },
              {
                key: "import-motec",
                label: "Import MoTeC log",
                icon: <Upload className="size-3.5" />,
                onClick: () => setMotecOpen(true),
              },
            ]}
          />
          {hasTelemetry && (
            <Button variant="app-outline" size="app-lg" onClick={onToggleAi} className={aiPanelOpen ? "text-app-accent border-app-accent/40 bg-app-accent/10" : "hover:text-app-accent"}>
              <Sparkles className="size-3.5" />
              {m.label_ai_analysis()}
            </Button>
          )}
          {loading && <span className="text-xs text-app-text-muted animate-pulse">{m.common_loading()}</span>}
        </div>
      </div>
      {guideOpen && <DataGuideModal onClose={() => setGuideOpen(false)} />}
      {motecOpen && (
        <MotecImportModal
          onClose={() => setMotecOpen(false)}
          // The imported laps land under AC Evo, which may not be the game
          // whose page we're on — invalidate broadly so they show up when the
          // user navigates there rather than only after a reload.
          onImported={() => {
            queryClient.invalidateQueries({ queryKey: ["laps"] });
            queryClient.invalidateQueries({ queryKey: ["sessions"] });
          }}
        />
      )}
    </>
  );
}
