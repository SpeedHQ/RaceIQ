import { formatLapTime } from "../../lib/format";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

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
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-xs font-medium text-app-text/90 uppercase tracking-wider">{m.analyse_import_result_title()}</DialogTitle>
        </DialogHeader>
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
        <DialogFooter className="border-0 bg-transparent p-0 -mx-0 -mb-0">
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>
            {m.common_close()}
          </Button>
          {laps.length > 0 && onGoToSession && (
            <Button variant="selected-toggle" size="app-sm" onClick={onGoToSession}>
              {sameGame ? m.analyse_import_view_session() : m.analyse_import_go_to_game({ game: gameLabel })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
