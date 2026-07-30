import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { IbtTelemetryWarning } from "./IbtTelemetryWarning";

export interface IbtImportPreview {
  gameId: "iracing";
  fileName: string;
  fileSize: number;
  tickRate: number;
  recordCount: number;
  durationSeconds: number;
  sessionStartDate: string;
  trackId: number;
  trackName: string;
  carId: number;
  carName: string;
  carClassName: string;
  missingRaceIQVariables: string[];
  missingRequiredVariables: string[];
  drivingFrames: number;
  pitRoadFrames: number;
  lapTransitions: number;
  candidateLapCount: number;
  maxSpeedMph: number;
  firstDrivingRecord: number | null;
  lastDrivingRecord: number | null;
  canImport: boolean;
  reason: string | null;
}

interface Props {
  token: string | null;
  preview: IbtImportPreview;
  importing: boolean;
  onImport: () => void;
  onClose: () => void;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${remainder}s` : `${minutes}m ${remainder}s`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function IbtImportPreviewModal({ token, preview, importing, onImport, onClose }: Props) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-xs font-medium text-app-text/90 uppercase tracking-wider">iRacing IBT import preview</DialogTitle>
          <p className="mt-1 text-xs text-app-text-muted truncate" title={preview.fileName}>
            {preview.fileName} · {formatSize(preview.fileSize)}
          </p>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-app-text-muted">Track</dt>
          <dd className="text-app-text">{preview.trackName}</dd>
          <dt className="text-app-text-muted">Car</dt>
          <dd className="text-app-text">
            {preview.carName}
            {preview.carClassName !== "Unknown class" ? ` · ${preview.carClassName}` : ""}
          </dd>
          <dt className="text-app-text-muted">Recording</dt>
          <dd className="text-app-text">
            {formatDuration(preview.durationSeconds)} · {preview.recordCount.toLocaleString()} rows at {preview.tickRate} Hz
          </dd>
          <dt className="text-app-text-muted">Driving</dt>
          <dd className="text-app-text">
            {preview.drivingFrames.toLocaleString()} on-track rows · max {preview.maxSpeedMph.toFixed(1)} mph
          </dd>
          <dt className="text-app-text-muted">Importable laps</dt>
          <dd className="text-app-text font-medium">{preview.candidateLapCount}</dd>
        </dl>

        {preview.missingRaceIQVariables.length > 0 && preview.missingRequiredVariables.length === 0 && <IbtTelemetryWarning missingVariables={preview.missingRaceIQVariables} />}

        {!preview.canImport && <p className="rounded border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">{preview.reason ?? "This recording cannot be imported."}</p>}

        <p className="text-xs text-app-text-muted">Import creates a normal RaceIQ iRacing session and canonical .bin capture. The original .ibt file is not copied into session storage.</p>

        <DialogFooter className="border-0 bg-transparent p-0 -mx-0 -mb-0">
          <Button variant="app-ghost" size="app-sm" disabled={importing} onClick={onClose}>
            {preview.canImport ? "Cancel" : "Close"}
          </Button>
          {preview.canImport && token && (
            <Button variant="app-primary" size="app-sm" disabled={importing} onClick={onImport}>
              {importing ? "Importing…" : `Import ${preview.candidateLapCount} ${preview.candidateLapCount === 1 ? "lap" : "laps"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
