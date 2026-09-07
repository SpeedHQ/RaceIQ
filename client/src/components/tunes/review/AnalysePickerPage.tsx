import type { GameId } from "@shared/games/ids";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useResolveNames } from "@/hooks/catalog-queries";
import { useSessions } from "@/hooks/session-queries";

export function AnalysePickerPage({ gameId }: { gameId: GameId }) {
  const navigate = useNavigate();
  const { data: sessions = [], isLoading } = useSessions();
  const trackOrdinals = useMemo(() => [...new Set(sessions.map((session) => session.trackOrdinal).filter((ordinal) => ordinal > 0))].sort((a, b) => a - b), [sessions]);
  const carOrdinals = useMemo(() => [...new Set(sessions.map((session) => session.carOrdinal).filter((ordinal) => ordinal > 0))].sort((a, b) => a - b), [sessions]);
  const { data: names, isLoading: namesLoading } = useResolveNames(trackOrdinals, carOrdinals);

  if (isLoading || namesLoading) return <div role="status" className="p-8 text-sm text-app-text-muted">Loading Analyse selections…</div>;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-app-text">Analyse</h1>
        <p className="mt-1 text-sm text-app-text-muted">Choose track and car to review recorded sessions for {gameId}.</p>
      </div>
      {trackOrdinals.length === 0 ? (
        <div className="rounded-lg border border-app-border p-6 text-sm text-app-text-muted">No recorded sessions available for this game.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {trackOrdinals.map((track) => {
            const cars = carOrdinals.filter((car) => sessions.some((session) => session.trackOrdinal === track && session.carOrdinal === car && session.bestLapTime != null));
            return (
              <div key={track} className="rounded-lg border border-app-border p-4">
                <div className="font-semibold text-app-text">{names?.trackNames[String(track)] ?? `Track ${track}`}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {cars.map((car) => {
                    const matchingSessions = sessions.filter((session) => session.trackOrdinal === track && session.carOrdinal === car);
                    const lapCount = matchingSessions.reduce((total, session) => total + (session.lapCount ?? 0), 0);
                    return (
                      <Button
                        key={car}
                        variant="app-outline"
                        size="app-sm"
                        aria-label={`Review ${names?.carNames[String(car)] ?? `Car ${car}`} on ${names?.trackNames[String(track)] ?? `Track ${track}`} (${matchingSessions.length} sessions)`}
                        onClick={() => void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, track, car, lap: undefined, laps: undefined }) } as never)}
                      >
                        {names?.carNames[String(car)] ?? `Car ${car}`} · {matchingSessions.length} sessions · {lapCount} laps
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
