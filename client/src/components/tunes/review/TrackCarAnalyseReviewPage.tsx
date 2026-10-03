import { m } from "@/paraglide/messages";
import type { GameId } from "@raceiq/shared/games/ids";
import { selectEvaluationLaps } from "@raceiq/shared/racing/laps/review-selection";
import { parseAnalyseLapIds } from "@/lib/game-routes";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useCarName, useResolveNames } from "@/hooks/catalog-queries";
import { useReviewLaps, useSessionLaps } from "@/hooks/laps";
import { useSessions } from "@/hooks/session-queries";
import { Button } from "@/components/ui/button";
import { useTrackName } from "@/hooks/track-queries";
import { getGameRoute } from "@/stores/game";
import { SessionReviewDashboard } from "./SessionReviewDashboard";

export function TrackCarAnalyseReviewPage({ gameId, trackOrdinal, carOrdinal, sessionId }: { gameId: GameId; trackOrdinal?: number; carOrdinal?: number; sessionId?: number }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { laps?: string; view?: string; tab?: string };
  const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError } = useSessions();
  const selectedSession = sessionId == null ? undefined : sessions.find((session) => session.id === sessionId);
  const resolvedTrackOrdinal = trackOrdinal ?? selectedSession?.trackOrdinal;
  const resolvedCarOrdinal = carOrdinal ?? selectedSession?.carOrdinal;
  const groupSessions = useMemo(
    () => sessions.filter((session) => session.trackOrdinal === resolvedTrackOrdinal && session.carOrdinal === resolvedCarOrdinal),
    [resolvedCarOrdinal, resolvedTrackOrdinal, sessions],
  );
  const groupQuery = useReviewLaps(resolvedTrackOrdinal ?? null, resolvedCarOrdinal ?? null);
  const sessionQuery = useSessionLaps(sessionId ?? null);
  const reviewLaps = sessionId != null ? (sessionQuery.data ?? []) : (groupQuery.data ?? []);
  const lapsLoading = sessionId != null ? sessionQuery.isLoading : groupQuery.isLoading;
  const { data: trackName, isLoading: trackLoading } = useTrackName(resolvedTrackOrdinal ?? undefined);
  const { data: resolvedNames, isLoading: namesLoading } = useResolveNames(resolvedTrackOrdinal != null ? [resolvedTrackOrdinal] : [], resolvedCarOrdinal != null ? [resolvedCarOrdinal] : []);
  const { data: carName, isLoading: carLoading } = useCarName(resolvedCarOrdinal ?? undefined);
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
  const resolvedTrackName = trackName ?? (resolvedTrackOrdinal != null ? resolvedNames?.trackNames[String(resolvedTrackOrdinal)] : undefined) ?? m.review_track_fallback({ ordinal: resolvedTrackOrdinal ?? "?" });
  const resolvedCarName = carName ?? (resolvedCarOrdinal != null ? resolvedNames?.carNames[String(resolvedCarOrdinal)] : undefined) ?? m.review_car_fallback({ ordinal: resolvedCarOrdinal ?? "?" });
  const sessionLabel = `${resolvedTrackName} · ${resolvedCarName} · ${m.review_selected_session()} · ${m.review_laps_count({ count: selectedSession?.lapCount ?? evaluationLaps.length })}`;
  const backToSession = () => void navigate({ to: sessionId != null ? "../.." : ".." } as never);
  if (sessionsLoading || lapsLoading || trackLoading || carLoading || namesLoading)
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
