import { EXPERIMENT_FOCUS_LABELS } from "@shared/racing/experiments/focus";
import { useState } from "react";
import { AppInput } from "@/components/ui/AppInput";
import { Button } from "@/components/ui/button";
import type { ExperimentGameId } from "@/hooks/experiments";
import { useExperiments } from "@/hooks/experiments";
import { ExperimentTable } from "./ExperimentTable";
import { NewExperimentModal } from "./NewExperimentModal";
import { NewF1ExperimentModal } from "./NewF1ExperimentModal";

export function ExperimentList({ gameId, onOpen }: { gameId: ExperimentGameId; onOpen: (id: number) => void }) {
  const { data: sessions = [], isLoading, isError } = useExperiments(gameId);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredSessions = normalizedSearch
    ? sessions.filter((session) =>
        [
          session.name,
          session.carName,
          session.trackName,
          session.baseSetupPath?.split(/[\\/]/).pop(),
          EXPERIMENT_FOCUS_LABELS[session.focus],
        ]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase().includes(normalizedSearch)),
      )
    : sessions;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-3 @3xl/workspace:p-4">
      <div className="space-y-2">
        <div>
          <h1 className="text-app-title font-semibold text-app-text">Experiments</h1>
          <p className="mt-0.5 text-app-subtext text-app-text-dim">An experiment tracks one car + track as you iterate setups — base setup, stints driven, versions, and lap deltas.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AppInput
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search experiments…"
            aria-label="Search experiments"
            className="min-w-[200px] flex-1 @3xl/workspace:w-64 @3xl/workspace:flex-none"
          />
          <Button variant="app-primary" size="app-md" onClick={() => setCreating(true)}>
            + New experiment
          </Button>
        </div>
      </div>
      {creating &&
        (gameId === "f1-2025" ? (
          <NewF1ExperimentModal
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              onOpen(id);
            }}
          />
        ) : (
          <NewExperimentModal
            gameId={gameId}
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              onOpen(id);
            }}
          />
        ))}
      <ExperimentTable sessions={filteredSessions} onOpen={onOpen} isLoading={isLoading} isError={isError} gameId={gameId} />
    </div>
  );
}
