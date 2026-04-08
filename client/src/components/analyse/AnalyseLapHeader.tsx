import type { LapMeta } from "@shared/types";
import { Sparkles } from "lucide-react";
import { SearchSelect } from "../ui/SearchSelect";
import { formatLapTime } from "../../lib/format";

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
  onCopyMetrics: () => void;
  onExport: () => void;
  onToggleAi: () => void;
}

export function AnalyseLapHeader({
  selectedTrack, selectedCar, selectedLapId, selectedLap,
  trackNames, carNames, tracks, carsForTrack, filteredLaps,
  hasTelemetry, hasF1Setup, availableTunes, tunePending,
  loading, aiPanelOpen,
  onTrackChange, onCarChange, onLapChange, onTuneChange, onViewTune, onShowSetup,
  onCopyMetrics, onExport, onToggleAi,
}: Props) {
  return (
    <div className="flex items-center gap-2 p-3 border-b border-app-border flex-wrap shrink-0">
      {/* Track selector */}
      <SearchSelect
        value={selectedTrack != null ? String(selectedTrack) : ""}
        onChange={(v) => onTrackChange(v ? Number(v) : null)}
        options={tracks.map(([ord, count]) => ({ value: String(ord), label: `${trackNames[ord] || `Track ${ord}`} (${count})` }))}
        placeholder="Search tracks..."
        className="min-w-[200px]"
        fallbackLabel={selectedTrack != null ? (trackNames[selectedTrack] || `Track ${selectedTrack}`) : undefined}
      />

      {/* Car selector */}
      <SearchSelect
        value={selectedCar != null ? String(selectedCar) : ""}
        onChange={(v) => onCarChange(v ? Number(v) : null)}
        options={carsForTrack.map(([ord, count]) => ({ value: String(ord), label: `${carNames[ord] || `Car ${ord}`} (${count})` }))}
        placeholder="Search cars..."
        disabled={selectedTrack == null}
        className="min-w-[200px]"
        fallbackLabel={selectedCar != null ? (carNames[selectedCar] || `Car ${selectedCar}`) : undefined}
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

      {/* Tune selector */}
      {selectedLapId && hasTelemetry && (
        <div className="flex items-center gap-2 text-sm">
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
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {selectedLap?.tuneId && (
            <button
              onClick={() => onViewTune(selectedLap.tuneId!)}
              className="px-2 py-1 text-xs bg-app-surface-alt border border-app-border-input rounded text-app-text-muted hover:text-app-text transition-colors"
            >
              View
            </button>
          )}
          {tunePending && (
            <span className="text-xs text-app-text-muted animate-pulse">Saving...</span>
          )}
          {hasF1Setup && (
            <button
              onClick={onShowSetup}
              className="px-2 py-1 text-xs bg-app-surface-alt border border-app-border-input rounded text-app-text-muted hover:text-app-text transition-colors"
            >
              Car Setup
            </button>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {hasTelemetry && (
          <button
            onClick={onCopyMetrics}
            className="text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
          >
            Copy
          </button>
        )}
        {hasTelemetry && (
          <button
            onClick={onExport}
            className="text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
          >
            Export CSV
          </button>
        )}
        {hasTelemetry && (
          <button
            onClick={onToggleAi}
            className={`flex items-center gap-1.5 text-xs border rounded px-3 py-1.5 transition-colors ${
              aiPanelOpen
                ? "text-amber-400 border-amber-400/40 bg-amber-400/10"
                : "text-app-text-secondary hover:text-amber-400 border-app-border-input"
            }`}
          >
            <Sparkles className="size-3" />
            AI
          </button>
        )}
        {loading && (
          <span className="text-xs text-app-text-muted animate-pulse">
            Loading...
          </span>
        )}
      </div>
    </div>
  );
}
