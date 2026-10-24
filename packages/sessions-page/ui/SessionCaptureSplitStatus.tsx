import type { ProcessingMetadata, SessionCaptureSplitStatus as CaptureSplitStatus } from "@raceiq/shared/racing/sessions/types";
import { useSessionsPageHost } from "./host";

type Props = {
  status?: CaptureSplitStatus;
  sessionId?: number;
  processing?: ProcessingMetadata;
  onRefreshProcessing?: () => void;
};

export function SessionProcessingStatus({ processing, onRefresh }: { processing: ProcessingMetadata; onRefresh: () => void }) {
  const { m, Button } = useSessionsPageHost();
  if (processing.state === "ready") return null;
  const pending = processing.state === "queued" || processing.state === "processing";
  return (
    <div className="mt-1 space-y-1 text-xs text-app-text/90" aria-busy={pending || undefined} data-processing-state={processing.state}>
      <div className="flex flex-wrap items-center gap-2">
        {pending && <span aria-hidden="true" className="size-3 shrink-0 rounded-full border border-app-border-input border-t-app-accent motion-safe:animate-spin" />}
        <span role={pending ? "status" : "alert"} aria-live={pending ? "polite" : "assertive"} aria-atomic="true">
          {processing.state === "queued"
            ? m.recording_processing_queued()
            : processing.state === "processing"
              ? m.recording_processing_running()
              : processing.error
                ? m.recording_processing_failed({ error: processing.error })
                : null}
        </span>
        {!pending && (
          <Button
            type="button"
            variant="app-outline"
            size="app-sm"
            onClick={(event) => {
              event.stopPropagation();
              onRefresh();
            }}
          >
            {m.recording_processing_refresh()}
          </Button>
        )}
      </div>
    </div>
  );
}

export function SessionCaptureSplitStatus({ status, sessionId, processing, onRefreshProcessing }: Props) {
  const { m, useLiveCaptureLifecycle } = useSessionsPageHost();
  const live = useLiveCaptureLifecycle(sessionId);
  const processingPending = processing?.state === "queued" || processing?.state === "processing";
  const processingStatus = processing && onRefreshProcessing && !(processingPending && status && status.phase !== "ready")
    ? <SessionProcessingStatus processing={processing} onRefresh={onRefreshProcessing} />
    : null;
  const phaseLabels = {
    queued: () => m.sessions_capture_split_queued(),
    splitting: () => m.sessions_capture_split_splitting(),
    verifying: () => m.sessions_capture_split_verifying(),
    publishing: () => m.sessions_capture_split_publishing(),
    failed: () => m.sessions_capture_split_failed(),
  };
  const errorMessages: Record<NonNullable<CaptureSplitStatus["errorCode"]>, () => string> = {
    "source-io": () => m.sessions_capture_split_error_source_io(),
    "malformed-capture": () => m.sessions_capture_split_error_malformed_capture(),
    "bootstrap-failed": () => m.sessions_capture_split_error_bootstrap_failed(),
    "verification-mismatch": () => m.sessions_capture_split_error_verification_mismatch(),
    "worker-failed": () => m.sessions_capture_split_error_worker_failed(),
    "stale-publication": () => m.sessions_capture_split_error_stale_publication(),
    "publication-failed": () => m.sessions_capture_split_error_publication_failed(),
  };
  if (!status) {
    if (!live) return processingStatus;
    const label = live.phase === "recording" ? "Recording" : live.phase === "finalizing" ? "Finalizing recording" : live.phase === "sealed" ? "Recording saved" : "Recording failed";
    return (
      <>
        {processingStatus}
        <div className="mt-1 text-xs text-app-text/90" data-phase={live.phase}>
          <span className="sr-only" role={live.phase === "failed" ? "alert" : "status"} aria-live={live.phase === "failed" ? "assertive" : "polite"}>{label}{live.error ? `: ${live.error}` : ""}</span>
          <span aria-hidden="true">{label}</span>
          {live.phase === "failed" && live.error && <p className="text-app-danger">{live.error}</p>}
        </div>
      </>
    );
  }
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
    <>
      {processingStatus}
      {phase !== "ready" && <div className="mt-1 space-y-1 text-xs text-app-text/90" data-phase={phase}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{phaseLabels[phase]()}</span>
          {(phase === "splitting" || phase === "verifying") && (
            <progress aria-label={phaseLabels[phase]()} className="h-1.5 w-20 accent-app-accent" max={100} value={determinate ? percent : undefined} />
          )}
          {determinate && <span>{m.sessions_capture_split_progress()}: {status.processedSourceFrames!.toLocaleString()} / {status.totalSourceFrames!.toLocaleString()}</span>}
          {(phase === "splitting" || phase === "verifying") && lapCountsKnown && <span>{m.sessions_capture_split_laps()}: {status.completedLapArtifacts} / {status.totalLapArtifacts}</span>}
        </div>
        <span className="sr-only" aria-live="polite" aria-atomic="true">{phaseLabels[phase]()} {phase === "failed" && status.errorCode ? errorMessages[status.errorCode]() : ""}</span>
        {phase === "failed" && <p className="text-app-danger">{status.errorCode ? errorMessages[status.errorCode]() : m.sessions_capture_split_error_worker_failed()}</p>}
      </div>}
      {live && <div className="mt-1 text-xs text-app-text/90" data-phase={live.phase}>
        <span className="sr-only" role={live.phase === "failed" ? "alert" : "status"} aria-live={live.phase === "failed" ? "assertive" : "polite"}>{live.phase === "recording" ? "Recording" : live.phase === "finalizing" ? "Finalizing recording" : live.phase === "sealed" ? "Recording saved" : "Recording failed"}{live.error ? `: ${live.error}` : ""}</span>
        <span aria-hidden="true">{live.phase === "recording" ? "Recording" : live.phase === "finalizing" ? "Finalizing recording" : live.phase === "sealed" ? "Recording saved" : "Recording failed"}</span>
        {live.phase === "failed" && live.error && <p className="text-app-danger">{live.error}</p>}
      </div>}
    </>
  );
}
