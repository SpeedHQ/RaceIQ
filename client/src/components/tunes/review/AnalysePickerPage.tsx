import type { GameId } from "@shared/games/ids";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useResolveNames } from "@/hooks/catalog-queries";
import { useLaps } from "@/hooks/laps";

export function AnalysePickerPage({ gameId }: { gameId: GameId }) {
  const navigate = useNavigate();
  const { data: laps = [], isLoading } = useLaps();
  const trackOrdinals = useMemo(() => [...new Set(laps.map((lap) => lap.trackOrdinal).filter((ordinal): ordinal is number => ordinal != null && ordinal > 0))].sort((a, b) => a - b), [laps]);
  const carOrdinals = useMemo(() => [...new Set(laps.map((lap) => lap.carOrdinal).filter((ordinal): ordinal is number => ordinal != null && ordinal > 0))].sort((a, b) => a - b), [laps]);
  const { data: names, isLoading: namesLoading } = useResolveNames(trackOrdinals, carOrdinals);
  const trackName = (ordinal: number) => names?.trackNames[String(ordinal)] ?? `Track ${ordinal}`;
  const carName = (ordinal: number) => names?.carNames[String(ordinal)] ?? `Car ${ordinal}`;

  if (isLoading || namesLoading) {
    return <div role="status" className="p-8 text-sm text-app-text-muted">Loading Analyse selections…</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-app-text">Analyse</h1>
        <p className="mt-1 text-sm text-app-text-muted">Choose track and car to review recorded laps for {gameId}.</p>
      </div>
      {trackOrdinals.length === 0 ? (
        <div className="rounded-lg border border-app-border p-6 text-sm text-app-text-muted">No recorded laps available for this game.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {trackOrdinals.map((track) => {
            const cars = carOrdinals.filter((car) => laps.some((lap) => lap.trackOrdinal === track && lap.carOrdinal === car));
            return (
              <div key={track} className="rounded-lg border border-app-border p-4">
                <div className="font-semibold text-app-text">{trackName(track)}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {cars.map((car) => {
                    const count = laps.filter((lap) => lap.trackOrdinal === track && lap.carOrdinal === car && lap.isValid && lap.lapTime > 0).length;
                    return (
                      <Button
                        key={car}
                        variant="app-outline"
                        size="app-sm"
                        aria-label={`Review ${carName(car)} on ${trackName(track)} (${count} valid laps)`}
                        onClick={() => void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, track, car, lap: undefined, laps: undefined }) } as never)}
                      >
                        {carName(car)} ({count})
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
