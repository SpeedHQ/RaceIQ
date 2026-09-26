import { m } from "@/paraglide/messages";
import type { GameId } from "@shared/games/ids";
import { selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import { parseAnalyseLapIds } from "@/lib/game-routes";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useReviewLaps, useSessionLaps } from "@/hooks/laps";
import { useSessions } from "@/hooks/session-queries";
import { Button } from "@/components/ui/button";
import { useTrackName } from "@/hooks/track-queries";
import { getGameRoute } from "@/stores/game";
import { SessionReviewDashboard } from "./SessionReviewDashboard";

export function TrackCarAnalyseReviewPage({ gameId, trackId, carId, sessionId }: { gameId: GameId; trackId?: string; carId?: string; sessionId?: number }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { laps?: string; view?: string; tab?: string };
  const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError } = useSessions();
  const selectedSession = sessionId == null ? undefined : sessions.find((session) => session.id === sessionId);
  const resolvedTrackId = trackId ?? selectedSession?.trackId ?? undefined;
  const resolvedCarId = carId ?? selectedSession?.carId ?? undefined;
  const groupSessions = useMemo(
    () => sessions.filter((session) => session.trackId === resolvedTrackId && session.carId === resolvedCarId),
    [resolvedCarId, resolvedTrackId, sessions],
  );
  const groupQuery = useReviewLaps(resolvedTrackId ?? null, resolvedCarId ?? null);
  const sessionQuery = useSessionLaps(sessionId ?? null);
  const reviewLaps = sessionId != null ? (sessionQuery.data ?? []) : (groupQuery.data ?? []);
  const lapsLoading = sessionId != null ? sessionQuery.isLoading : groupQuery.isLoading;
  const numericTrackId = gameId !== "acc" && gameId !== "ac-evo" && resolvedTrackId != null && /^\d+$/.test(resolvedTrackId) ? Number(resolvedTrackId) : undefined;
  const { data: trackName, isLoading: trackLoading } = useTrackName(numericTrackId);
  const comparisonCandidates = useMemo(() => {
    const requestedLapIds = parseAnalyseLapIds(search.laps);
    if (!requestedLapIds) return reviewLaps;
    const requestedLapIdSet = new Set(requestedLapIds);
    return reviewLaps.filter((lap) => requestedLapIdSet.has(lap.id));
  }, [reviewLaps, search.laps]);
  const evaluationLaps = useMemo(() => selectEvaluationLaps(comparisonCandidates).chosen, [comparisonCandidates]);
  const sessionRedirectId = useMemo(() => {
    if (sessionId != null) return null;
    const requestedLapIds = parseAnalyseLapIds(search.laps);
    if (!requestedLapIds || requestedLapIds.length === 0 || comparisonCandidates.length !== requestedLapIds.length) return null;
    const candidateSessionId = comparisonCandidates[0]?.sessionId;
    return candidateSessionId != null && comparisonCandidates.every((lap) => lap.sessionId === candidateSessionId) ? candidateSessionId : null;
  }, [comparisonCandidates, search.laps, sessionId]);
  useEffect(() => {
    if (sessionRedirectId == null) return;
    void navigate({ search: { session: sessionRedirectId } } as never);
  }, [navigate, sessionRedirectId]);
  const resolvedTrackName = trackName ?? resolvedTrackId ?? m.review_track_fallback({ ordinal: "?" });
  const resolvedCarName = resolvedCarId ?? m.review_car_fallback({ ordinal: "?" });
  const sessionLabel = `${resolvedTrackName} · ${resolvedCarName} · ${m.review_selected_session()} · ${m.review_laps_count({ count: selectedSession?.lapCount ?? evaluationLaps.length })}`;
  const backToSession = () => void navigate({ to: sessionId != null ? "../.." : ".." } as never);
  if (sessionsLoading || lapsLoading || trackLoading)
    return (
      <div role="status" aria-live="polite" className="flex h-full items-center p-8 text-sm text-app-text-muted">
        {m.review_loading_analyse()}
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
  if (sessionId == null && evaluationLaps.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p role="status" className="text-sm text-app-text-muted">
          {groupSessions.length === 0 ? m.review_no_matching_session() : m.review_no_valid_laps()}
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
        onDrillIntoLap={(lap) => void navigate({ to: `${getGameRoute(gameId)}/sessions/${lap.sessionId}/replay/${lap.id}` as never })}
      />
    </div>
  );
}
