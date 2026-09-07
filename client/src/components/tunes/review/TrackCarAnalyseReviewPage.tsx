import type { GameId } from "@shared/games/ids";
import { selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import { parseAnalyseLapIds } from "@/lib/game-routes";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useCarName, useResolveNames } from "@/hooks/catalog-queries";
import { useReviewLaps, useSessionLineSpread, useSessionReviewLaps } from "@/hooks/laps";
import { useSessions } from "@/hooks/session-queries";
import { Button } from "@/components/ui/button";
import { useTrackName } from "@/hooks/track-queries";
import { SessionReviewDashboard } from "./SessionReviewDashboard";

export function TrackCarAnalyseReviewPage({ gameId, trackOrdinal, carOrdinal, sessionId }: { gameId: GameId; trackOrdinal?: number; carOrdinal?: number; sessionId?: number }) {
  const navigate = useNavigate({ from: "/$gameid/analyse" });
  const search = useSearch({ strict: false }) as { laps?: string; view?: string; trackTab?: string };
  const { data: sessions = [], isLoading: sessionsLoading } = useSessions();
  const selectedSession = sessionId == null ? undefined : sessions.find((session) => session.id === sessionId);
  const resolvedTrackOrdinal = trackOrdinal ?? selectedSession?.trackOrdinal;
  const resolvedCarOrdinal = carOrdinal ?? selectedSession?.carOrdinal;
  const groupSessions = useMemo(() => sessions.filter((session) => session.trackOrdinal === resolvedTrackOrdinal && session.carOrdinal === resolvedCarOrdinal), [resolvedCarOrdinal, resolvedTrackOrdinal, sessions]);
  const groupQuery = useReviewLaps(resolvedTrackOrdinal ?? null, resolvedCarOrdinal ?? null);
  const sessionQuery = useSessionReviewLaps(sessionId ?? null);
  const reviewLaps = sessionId != null ? sessionQuery.data ?? [] : groupQuery.data ?? [];
  const lapsLoading = sessionId != null ? sessionQuery.isLoading : groupQuery.isLoading;
  const { data: sessionLineSpread } = useSessionLineSpread(sessionId ?? null, search.view === "track" && (search.trackTab ?? "consistency") === "consistency");
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
    void navigate({ search: { session: sessionRedirectId } });
  }, [navigate, sessionRedirectId]);
  const resolvedTrackName = trackName ?? (resolvedTrackOrdinal != null ? resolvedNames?.trackNames[String(resolvedTrackOrdinal)] : undefined) ?? `Track ${resolvedTrackOrdinal ?? "?"}`;
  const resolvedCarName = carName ?? (resolvedCarOrdinal != null ? resolvedNames?.carNames[String(resolvedCarOrdinal)] : undefined) ?? `Car ${resolvedCarOrdinal ?? "?"}`;
  const backToPicker = () => void navigate({ search: { session: undefined, track: undefined, car: undefined, lap: undefined, laps: undefined } });
  if (sessionsLoading || lapsLoading || trackLoading || carLoading || namesLoading) return <div role="status" aria-live="polite" className="p-8 text-sm text-app-text-muted">Loading Analyse review…</div>;


  if (sessionRedirectId != null) return <div role="status" aria-live="polite" className="p-8 text-sm text-app-text-muted">Opening session review…</div>;
  if (sessionId == null) {
    return <div className="flex min-h-[18rem] flex-col items-center justify-center gap-3 p-8 text-center"><p role="alert" className="text-sm text-app-text-muted">Session selection required for Analyse review.</p><Button variant="app-outline" size="app-sm" onClick={backToPicker}>Back to Analyse picker</Button></div>;
  }
  if (evaluationLaps.length === 0) {
    return <div className="flex min-h-[18rem] flex-col items-center justify-center gap-3 p-8 text-center"><p role="status" className="text-sm text-app-text-muted">{groupSessions.length === 0 ? "No recorded session matches this selection." : "No valid laps are available for review."}</p><Button variant="app-outline" size="app-sm" onClick={backToPicker}>Back to Analyse picker</Button></div>;
  }

  return <div className="flex flex-col gap-3 p-3"><div className="px-1 text-sm text-app-text-muted">{resolvedTrackName} · {resolvedCarName} · {sessionId != null ? "Selected session" : `${groupSessions.length} sessions`} · {sessionId != null ? selectedSession?.lapCount ?? evaluationLaps.length : groupSessions.reduce((total, session) => total + (session.lapCount ?? 0), 0)} laps</div><SessionReviewDashboard gameId={gameId} stayOnSessionReview autoSelectLap={false} laps={evaluationLaps} trackName={resolvedTrackName} onBack={backToPicker} lineSpread={sessionLineSpread ?? null} /></div>;
}
