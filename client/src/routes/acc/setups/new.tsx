import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SetupTuneForm } from "../../../components/setup-tune/SetupTuneForm";
import { useAccCars } from "../../../components/setup-tune/use-game-cars";
import { useCreateTune } from "../../../hooks/tunes";

function NewAccTunePage() {
  const navigate = useNavigate();
  const createTune = useCreateTune();
  const { data: cars = [] } = useAccCars();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <SetupTuneForm
          gameId="acc"
          cars={cars}
          title="Create New ACC Tune"
          onCancel={() => navigate({ to: "/acc/setups" })}
          onSubmit={(data) =>
            createTune.mutate(data, {
              onSuccess: () => navigate({ to: "/acc/setups" }),
            })
          }
          isSubmitting={createTune.isPending}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/acc/setups/new")({
  component: NewAccTunePage,
});
