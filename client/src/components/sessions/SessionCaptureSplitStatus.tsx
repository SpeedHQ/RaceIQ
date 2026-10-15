import type { SessionCaptureSplitStatus as CaptureSplitStatus } from "@raceiq/shared/racing/sessions/types";
import { m } from "@/paraglide/messages";

type Props = { status?: CaptureSplitStatus };

const phaseLabels = {
  queued: () => m.sessions_capture_split_queued(),
  splitting: () => m.sessions_capture_split_splitting(),
  verifying: () => m.sessions_capture_split_verifying(),
  publishing: () => m.sessions_capture_split_publishing(),
  ready: () => m.sessions_capture_split_ready(),
  failed: () => m.sessions_capture_split_failed(),
} as const;

const errorMessages: Record<NonNullable<CaptureSplitStatus["errorCode"]>, () => string> = {
  "source-io": () => m.sessions_capture_split_error_source_io(),
  "malformed-capture": () => m.sessions_capture_split_error_malformed_capture(),
  "bootstrap-failed": () => m.sessions_capture_split_error_bootstrap_failed(),
  "verification-mismatch": () => m.sessions_capture_split_error_verification_mismatch(),
  "worker-failed": () => m.sessions_capture_split_error_worker_failed(),
  "stale-publication": () => m.sessions_capture_split_error_stale_publication(),
  "publication-failed": () => m.sessions_capture_split_error_publication_failed(),
};
export function SessionCaptureSplitStatus({ status }: Props) {
  if (!status) return null;
  const { phase } = status;
  const determinate = (phase === "splitting" || phase === "verifying")
    && Number.isFinite(status.processedSourceFrames)
    && status.processedSourceFrames! >= 0
    && Number.isFinite(status.totalSourceFrames)
    && status.totalSourceFrames! > 0
    && status.processedSourceFrames! <= status.totalSourceFrames!;
  const lapCountsKnown = Number.isFinite(status.completedLapArtifacts)
    && status.completedLapArtifacts >= 0
    && Number.isFinite(status.totalLapArtifacts)
    && status.totalLapArtifacts >= status.completedLapArtifacts;
  const percent = determinate
    ? Math.round((status.processedSourceFrames! / status.totalSourceFrames!) * 100)
    : undefined;
  return (
    <div className="mt-1 space-y-1 text-xs text-app-text/90" data-phase={phase}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{phaseLabels[phase]()}</span>
        {(phase === "splitting" || phase === "verifying") && (
          <progress
            aria-label={phaseLabels[phase]()}
            className="h-1.5 w-20 accent-app-accent"
            max={100}
            value={determinate ? percent : undefined}
          />
        )}
        {determinate && <span>{m.sessions_capture_split_progress()}: {status.processedSourceFrames!.toLocaleString()} / {status.totalSourceFrames!.toLocaleString()}</span>}
        {(phase === "splitting" || phase === "verifying") && lapCountsKnown && <span>{m.sessions_capture_split_laps()}: {status.completedLapArtifacts} / {status.totalLapArtifacts}</span>}
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{phaseLabels[phase]()} {phase === "failed" && status.errorCode ? errorMessages[status.errorCode]() : ""}</span>
      {phase === "failed" && <p className="text-app-danger">{status.errorCode ? errorMessages[status.errorCode]() : m.sessions_capture_split_error_worker_failed()}</p>}
    </div>
  );
}
