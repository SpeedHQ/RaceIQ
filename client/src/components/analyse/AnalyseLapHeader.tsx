import { useState } from "react";
import type { LapMeta } from "@shared/types";
import { Sparkles, Trash2, NotebookPen } from "lucide-react";
import { SearchSelect } from "../ui/SearchSelect";
import { Button } from "../ui/button";
import { formatLapTime } from "../../lib/format";
import { DataGuideModal } from "./DataGuideModal";
import { NoteModal } from "../ui/NoteModal";

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
  onToggleAi,
  onDeleteLap,
  onNotesChange,
}: Props) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-2 p-3 border-b border-app-border flex-wrap shrink-0">
        {/* Track selector */}
        <SearchSelect
          value={selectedTrack != null ? String(selectedTrack) : ""}
          onChange={(v) => onTrackChange(v ? Number(v) : null)}
          options={tracks.map(([ord, count]) => ({ value: String(ord), label: `${trackNames[ord] || `Track ${ord}`} (${count})` }))}
          placeholder="Search tracks..."
          className="min-w-[200px]"
          fallbackLabel={selectedTrack != null ? trackNames[selectedTrack] || `Track ${selectedTrack}` : undefined}
        />

        {/* Car selector */}
        <SearchSelect
          value={selectedCar != null ? String(selectedCar) : ""}
          onChange={(v) => onCarChange(v ? Number(v) : null)}
          options={carsForTrack.map(([ord, count]) => ({ value: String(ord), label: `${carNames[ord] || `Car ${ord}`} (${count})` }))}
          placeholder="Search cars..."
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
          placeholder="Search laps..."
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
                Car Setup
              </Button>
            ) : (
              <>
                <span className="text-app-text-muted">Tune:</span>
                <select
                  value={selectedLap?.tuneId ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    onTuneChange(val ? parseInt(val, 10) : null);
                  }}
                  disabled={tunePending}
                  className="bg-app-surface border border-app-border-input rounded px-2 py-1 text-sm text-app-text"
                >
                  <option value="">No tune</option>
                  {availableTunes?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {selectedLap?.tuneId && (
                  <Button variant="app-outline" size="app-sm" onClick={() => onViewTune(selectedLap.tuneId!)}>
                    View
                  </Button>
                )}
                {tunePending && <span className="text-xs text-app-text-muted animate-pulse">Saving...</span>}
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
              title={selectedLap?.notes || "Add note"}
            >
              <NotebookPen className="size-3.5" />
              {selectedLap?.notes ? "Notes" : "Add Notes"}
            </Button>
          )}
          {selectedLapId != null && (
            <Button variant="app-outline" size="app-md" onClick={onDeleteLap} className="text-red-400 border-red-400/30 hover:bg-red-400/10">
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}
          {hasTelemetry && (
            <Button variant="app-outline" size="app-md" onClick={() => setGuideOpen(true)}>
              Guide
            </Button>
          )}
          {hasTelemetry && (
            <Button variant="app-outline" size="app-md" onClick={onExport}>
              Export CSV
            </Button>
          )}
          {hasTelemetry && (
            <Button variant="app-outline" size="app-lg" onClick={onToggleAi} className={aiPanelOpen ? "text-app-accent border-app-accent/40 bg-app-accent/10" : "hover:text-app-accent"}>
              <Sparkles className="size-3.5" />
              AI Analysis
            </Button>
          )}
          {loading && <span className="text-xs text-app-text-muted animate-pulse">Loading...</span>}
        </div>
      </div>
      {guideOpen && <DataGuideModal onClose={() => setGuideOpen(false)} />}
    </>
  );
}
