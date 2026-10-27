import { useSessionAnalyseHost } from "./host";
import type { ProcessingMetadata } from "@raceiq/shared/racing/sessions/types";
import type { GameId } from "@raceiq/shared/games/ids";
import { selectEvaluationLaps } from "@raceiq/analysis-core/racing/laps/review-selection";
import { parseAnalyseLapIds } from "@raceiq/session-analyse/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useReviewLaps } from "./queries";
import { SessionReviewDashboard } from "./SessionReviewDashboard";

export function SessionProcessingShell({
  processing,
  loading = false,
  error,
  onRefresh,
}: {
  processing?: ProcessingMetadata;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
}) {
  const { m, Button } = useSessionAnalyseHost();
  if (!loading && !error && (!processing || processing.state === "ready")) return null;
  const checking = loading || (!error && processing == null);
  const pending = processing?.state === "queued" || processing?.state === "processing";
  const failed = processing?.state === "failed";
  const message = error
    ?? (checking ? m.recording_processing_loading()
      : processing?.state === "queued" ? m.recording_processing_queued()
        : processing?.state === "processing" ? m.recording_processing_running()
          : processing?.state === "failed" ? m.recording_processing_failed({ error: processing.error })
            : "");
  return (
    <div
      role={error || failed ? "alert" : "status"}
      aria-live="polite"
      aria-busy={checking || pending}
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-app-text-muted"
    >
      {(checking || pending) && <span aria-hidden="true" className="size-5 rounded-full border-2 border-app-border-input border-t-app-accent motion-safe:animate-spin" />}
      <p>{message}</p>
      {(error || failed) && onRefresh && (
        <Button variant="app-outline" size="app-sm" onClick={onRefresh}>
          {m.recording_processing_refresh()}
        </Button>
      )}
    </div>
  );
}


export function SessionAnalysePage({ gameId, trackId, carId, sessionId }: { gameId: GameId; trackId?: string; carId?: string; sessionId?: number }) {
  const { m, Button, useSessions, useSessionLaps, useTrackName, useResolveNames, useCarName, getGameRoute } = useSessionAnalyseHost();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { laps?: string; view?: string; tab?: string };
  const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError, refetch: refreshSessions } = useSessions();
  const selectedSession = sessionId == null ? undefined : sessions.find((session) => session.id === sessionId);
  const resolvedTrackId = trackId ?? selectedSession?.trackId;
  const resolvedCarId = carId ?? selectedSession?.carId;
  const groupQuery = useReviewLaps(resolvedTrackId ?? null, resolvedCarId ?? null);
  const sessionQuery = useSessionLaps(sessionId ?? null);
  const allReviewLaps = sessionId != null ? (sessionQuery.data ?? []) : (groupQuery.data ?? []);
  const requestedLapIds = useMemo(() => parseAnalyseLapIds(search.laps), [search.laps]);
  const reviewLaps = useMemo(() => allReviewLaps.filter((lap) => lap.processing.state === "ready"), [allReviewLaps]);
  const lapsLoading = sessionId != null ? sessionQuery.isLoading : groupQuery.isLoading;
  const { data: trackName, isLoading: trackLoading } = useTrackName(resolvedTrackId ?? undefined);
  const { data: resolvedNames, isLoading: namesLoading } = useResolveNames(resolvedTrackId != null ? [resolvedTrackId] : [], resolvedCarId != null ? [resolvedCarId] : []);
  const { data: carName, isLoading: carLoading } = useCarName(resolvedCarId ?? undefined);
  const comparisonCandidates = useMemo(() => {
    if (!requestedLapIds) return reviewLaps;
    const requestedLapIdSet = new Set(requestedLapIds);
    return reviewLaps.filter((lap) => requestedLapIdSet.has(lap.id));
  }, [reviewLaps, requestedLapIds]);
  const blockedRequestedLap = useMemo(
    () => requestedLapIds?.length
      ? allReviewLaps.find((lap) => requestedLapIds.includes(lap.id) && lap.processing.state !== "ready")
      : undefined,
    [allReviewLaps, requestedLapIds],
  );
  const evaluationLaps = useMemo(() => selectEvaluationLaps(comparisonCandidates).chosen, [comparisonCandidates]);
  const sessionRedirectId = useMemo(() => {
    if (sessionId != null) return null;
    if (!requestedLapIds || requestedLapIds.length === 0 || comparisonCandidates.length !== requestedLapIds.length) return null;
    const candidateSessionId = comparisonCandidates[0]?.sessionId;
    return candidateSessionId != null && comparisonCandidates.every((lap) => lap.sessionId === candidateSessionId) ? candidateSessionId : null;
  }, [comparisonCandidates, requestedLapIds, sessionId]);
  useEffect(() => {
    if (sessionRedirectId == null) return;
    void navigate({ search: { session: sessionRedirectId } } as never);
  }, [navigate, sessionRedirectId]);
  const resolvedTrackName = trackName ?? (resolvedTrackId != null ? resolvedNames?.trackNames[resolvedTrackId] : undefined) ?? m.review_track_fallback({ ordinal: resolvedTrackId ?? "?" });
  const resolvedCarName = carName ?? (resolvedCarId != null ? resolvedNames?.carNames[resolvedCarId] : undefined) ?? m.review_car_fallback({ ordinal: resolvedCarId ?? "?" });
  const sessionLabel = `${resolvedTrackName} · ${resolvedCarName} · ${m.review_selected_session()} · ${m.review_laps_count({ count: selectedSession?.lapCount ?? evaluationLaps.length })}`;
  const backToSession = () => void navigate({ to: sessionId != null ? "../.." : ".." } as never);
  if (sessionId != null && (sessionsLoading || sessionQuery.isLoading))
    return <SessionProcessingShell loading />;
  if (sessionsLoading || lapsLoading || trackLoading || carLoading || namesLoading)
    return (
      <div role="status" aria-live="polite" aria-label={m.review_loading_analyse()} className="flex h-full items-center justify-center p-8">
        <span aria-hidden="true" className="size-5 rounded-full border-2 border-app-border-input border-t-app-accent motion-safe:animate-spin" />
      </div>
    );
  if (sessionsError || sessionQuery.isError || (sessionId != null && !selectedSession)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p role="alert" className="text-sm text-status-danger">
          {sessionsError || sessionQuery.isError ? m.review_load_session_error() : m.review_session_not_found()}
        </p>
        <Button variant="app-outline" size="app-sm" onClick={backToSession}>
          {m.review_back_to_sessions()}
        </Button>
      </div>
    );
  }

  const refreshStatus = () => {
    void Promise.all([
      refreshSessions(),
      sessionId != null ? sessionQuery.refetch() : groupQuery.refetch(),
    ]);
  };
  if (sessionId != null && selectedSession && selectedSession.processing.state !== "ready")
    return <SessionProcessingShell processing={selectedSession.processing} onRefresh={refreshStatus} />;
  if (blockedRequestedLap)
    return <SessionProcessingShell processing={blockedRequestedLap.processing} onRefresh={refreshStatus} />;

  if (sessionRedirectId != null)
    return (
      <div role="status" aria-live="polite" className="flex h-full items-center p-8 text-sm text-app-text-muted">
        {m.review_opening_session()}
      </div>
    );
  if (sessionId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p role="alert" className="text-sm text-app-text-muted">
          {m.review_session_selection_required_analyse()}
        </p>
        <Button variant="app-outline" size="app-sm" onClick={backToSession}>
          {m.review_back_to_sessions()}
        </Button>
      </div>
    );
  }
  if (evaluationLaps.length === 0 && search.laps == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p role="status" className="text-sm text-app-text-muted">
          {m.review_no_valid_laps()}
        </p>
        <Button variant="app-outline" size="app-sm" onClick={backToSession}>
          {m.review_back_to_sessions()}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <SessionReviewDashboard
        stayOnSessionReview={sessionId != null}
        autoSelectLap={false}
        laps={sessionId != null ? reviewLaps : evaluationLaps}
        gameId={gameId}
        sessionId={sessionId}
        sessionLabel={sessionLabel}
        onBack={backToSession}
        onDrillIntoLap={(lap) => {
          if (!allReviewLaps.some((candidate) => candidate.id === lap.id && candidate.processing.state === "ready")) return;
          void navigate({ to: `${getGameRoute(gameId)}/sessions/${lap.sessionId}/replay/${lap.id}` as never });
        }}
      />
    </div>
  );
}
