import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ExperimentGameId } from "@/hooks/experiments";
import { useExperiments } from "@/hooks/experiments";
import { ExperimentTable } from "./ExperimentTable";
import { NewExperimentModal } from "./NewExperimentModal";
import { NewF1ExperimentModal } from "./NewF1ExperimentModal";

export function ExperimentList({ gameId, onOpen }: { gameId: ExperimentGameId; onOpen: (id: number) => void }) {
  const { data: sessions = [], isLoading, isError } = useExperiments(gameId);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-3 @3xl/workspace:p-4">
      <div className="space-y-2">
        <div>
          <h1 className="text-app-title font-semibold text-app-text">Experiments</h1>
          <p className="mt-0.5 text-app-subtext text-app-text-dim">An experiment tracks one car + track as you iterate setups — base setup, stints driven, versions, and lap deltas.</p>
        </div>
        <Button variant="app-primary" size="app-md" onClick={() => setCreating(true)} className="self-start">
          + New experiment
        </Button>
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
      <ExperimentTable sessions={sessions} onOpen={onOpen} isLoading={isLoading} isError={isError} gameId={gameId} />
    </div>
  );
}
