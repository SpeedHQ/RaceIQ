import { createPortal } from "react-dom";
import { formatLapTime } from "../../lib/format";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";

export interface ImportedLapSummary {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
}

interface Props {
  fileName: string;
  packetCount: number;
  laps: ImportedLapSummary[];
  sameGame: boolean;
  gameLabel: string;
  onGoToSession?: () => void;
  onClose: () => void;
}

export function ImportResultModal({ fileName, packetCount, laps, sameGame, gameLabel, onGoToSession, onClose }: Props) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[480px] max-w-[90vw] flex flex-col gap-3 p-4">
        <p className="text-xs font-medium text-app-text/90 uppercase tracking-wider">{m.analyse_import_result_title()}</p>
        <p className="text-xs text-app-text-muted truncate" title={fileName}>
          {fileName} · {packetCount.toLocaleString()} {m.analyse_import_packets_label()}
        </p>
        {laps.length === 0 ? (
          <p className="text-sm text-app-text-muted">{m.analyse_import_no_laps()}</p>
        ) : (
          <div className="max-h-64 overflow-auto border border-app-border-input rounded">
            {laps.map((lap) => (
              <div key={lap.lapId} className="flex items-center justify-between px-3 py-1.5 text-sm border-b border-app-border-input last:border-b-0">
                <span className="text-app-text">Lap {lap.lapNumber}</span>
                <span className="text-app-text-muted">{formatLapTime(lap.lapTime)}</span>
                {!lap.isValid && <span className="text-xs text-status-danger">{m.analyse_import_invalid_badge()}</span>}
              </div>
            ))}
          </div>
        )}
        {!sameGame && laps.length > 0 && <p className="text-xs text-app-text-muted">{m.analyse_import_different_game({ game: gameLabel })}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>
            {m.common_close()}
          </Button>
          {laps.length > 0 && onGoToSession && (
            <Button variant="app-outline" size="app-sm" className="bg-app-accent/15 !border-app-accent/40 text-app-accent hover:bg-app-accent/25" onClick={onGoToSession}>
              {sameGame ? m.analyse_import_view_session() : m.analyse_import_go_to_game({ game: gameLabel })}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
