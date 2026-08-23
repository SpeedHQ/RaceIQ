import type { GameId } from "@shared/games/ids";
import { selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import { parseAnalyseLapIds } from "@/lib/game-routes";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useCarName, useResolveNames } from "@/hooks/catalog-queries";
import { useLaps } from "@/hooks/laps";
import { Button } from "@/components/ui/button";
import { useTrackName } from "@/hooks/track-queries";
import { TuneReviewDashboard } from "./TuneReviewDashboard";

export function TrackCarAnalyseReviewPage({ gameId, trackOrdinal, carOrdinal }: { gameId: GameId; trackOrdinal: number; carOrdinal: number }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { laps?: string };
  const { data: laps = [], isLoading: lapsLoading } = useLaps();
  const { data: trackName, isLoading: trackLoading } = useTrackName(trackOrdinal);
  const { data: resolvedNames, isLoading: namesLoading } = useResolveNames([trackOrdinal], [carOrdinal]);
  const { data: carName, isLoading: carLoading } = useCarName(carOrdinal);
  const groupLaps = useMemo(() => laps.filter((lap) => lap.trackOrdinal === trackOrdinal && lap.carOrdinal === carOrdinal), [carOrdinal, laps, trackOrdinal]);
  const comparisonCandidates = useMemo(() => {
    const requestedLapIds = parseAnalyseLapIds(search.laps);
    if (!requestedLapIds) return groupLaps;
    const requestedLapIdSet = new Set(requestedLapIds);
    return groupLaps.filter((lap) => requestedLapIdSet.has(lap.id));
  }, [groupLaps, search.laps]);
  const evaluationLaps = useMemo(() => selectEvaluationLaps(comparisonCandidates).chosen, [comparisonCandidates]);
  const canonicalLaps = evaluationLaps.map((lap) => lap.id).join(",");
  const resolvedTrackName = trackName ?? resolvedNames?.trackNames[String(trackOrdinal)] ?? `Track ${trackOrdinal}`;
  const resolvedCarName = carName ?? resolvedNames?.carNames[String(carOrdinal)] ?? `Car ${carOrdinal}`;
  const backToPicker = () => void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, track: undefined, car: undefined, lap: undefined, laps: undefined }) } as never);

  useEffect(() => {
    if (lapsLoading || trackLoading || carLoading || namesLoading || evaluationLaps.length === 0) return;
    if (search.laps === canonicalLaps) return;
    void navigate({ replace: true, search: (previous: Record<string, unknown>) => ({ ...previous, track: trackOrdinal, car: carOrdinal, lap: undefined, laps: canonicalLaps }) } as never);
  }, [carLoading, carOrdinal, canonicalLaps, evaluationLaps.length, lapsLoading, namesLoading, navigate, search.laps, trackLoading, trackOrdinal]);

  if (lapsLoading || trackLoading || carLoading || namesLoading) {
    return <div role="status" aria-live="polite" className="p-8 text-sm text-app-text-muted">Loading Analyse review…</div>;
  }
  if (gameId !== "acc" && gameId !== "ac-evo") {
    return <div role="alert" className="p-8 text-sm text-app-text-muted">Analyse review is unavailable for this game.</div>;
  }
  if (evaluationLaps.length === 0) {
    return (
      <div className="flex min-h-[18rem] flex-col items-center justify-center gap-3 p-8 text-center">
        <p role="status" className="text-sm text-app-text-muted">
          {groupLaps.length === 0 ? "No recorded laps match this track and car." : "No valid laps are available for review."}
        </p>
        <Button variant="app-outline" size="app-sm" onClick={backToPicker}>
          Back to Analyse picker
        </Button>
      </div>
    );
  }


  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="px-1 text-sm text-app-text-muted">{resolvedTrackName} · {resolvedCarName}</div>
      <div className="rounded-lg border border-app-border">
        <TuneReviewDashboard
          gameId={gameId}
          autoSelectLap={false}
          laps={evaluationLaps}
          trackName={resolvedTrackName}
          onBack={backToPicker}
        />
      </div>
    </div>
  );
}
