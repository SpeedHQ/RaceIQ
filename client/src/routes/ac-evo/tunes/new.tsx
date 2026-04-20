import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SetupTuneForm } from "../../../components/setup-tune/SetupTuneForm";
import { useAcEvoCars } from "../../../components/setup-tune/use-game-cars";
import { useCreateTune } from "../../../hooks/queries";

function NewAcEvoTunePage() {
  const navigate = useNavigate();
  const createTune = useCreateTune();
  const { data: cars = [] } = useAcEvoCars();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <SetupTuneForm
          gameId="ac-evo"
          cars={cars}
          title="Create New AC EVO Tune"
          onCancel={() => navigate({ to: "/ac-evo/tunes" })}
          onSubmit={(data) =>
            createTune.mutate(data, {
              onSuccess: () => navigate({ to: "/ac-evo/tunes" }),
            })
          }
          isSubmitting={createTune.isPending}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/ac-evo/tunes/new")({
  component: NewAcEvoTunePage,
});
