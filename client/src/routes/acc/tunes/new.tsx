import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SetupTuneForm } from "../../../components/setup-tune/SetupTuneForm";
import { useAccCars } from "../../../components/setup-tune/use-game-cars";
import { useCreateTune } from "../../../hooks/queries";

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
          onCancel={() => navigate({ to: "/acc/tunes" })}
          onSubmit={(data) =>
            createTune.mutate(data, {
              onSuccess: () => navigate({ to: "/acc/tunes" }),
            })
          }
          isSubmitting={createTune.isPending}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/acc/tunes/new")({
  component: NewAccTunePage,
});
