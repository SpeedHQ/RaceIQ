import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { client } from "../../../lib/rpc";
import { SetupTuneForm } from "../../../components/setup-tune/SetupTuneForm";
import { useAcEvoCars } from "../../../components/setup-tune/use-game-cars";
import { useUpdateTune } from "../../../hooks/queries";

interface TuneRow {
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  description: string;
  settings: Record<string, unknown>;
}

function EditAcEvoTunePage() {
  const { tuneId } = Route.useParams();
  const navigate = useNavigate();
  const updateTune = useUpdateTune();
  const { data: cars = [] } = useAcEvoCars();

  const { data: tune, isLoading } = useQuery<TuneRow>({
    queryKey: ["tune", tuneId],
    queryFn: async () =>
      (await client.api.tunes[":id"].$get({ param: { id: String(tuneId) } })).json() as Promise<TuneRow>,
  });

  if (isLoading) return <div className="p-4 text-app-text-muted text-sm">Loading tune...</div>;
  if (!tune) return <div className="p-4 text-app-text-muted text-sm">Tune not found</div>;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <SetupTuneForm
          gameId="ac-evo"
          cars={cars}
          title={`Edit: ${tune.name}`}
          initialData={{
            name: tune.name,
            author: tune.author,
            carOrdinal: tune.carOrdinal,
            category: tune.category,
            description: tune.description,
            settings: tune.settings,
          }}
          onCancel={() => navigate({ to: "/ac-evo/setups" })}
          onSubmit={(data) =>
            updateTune.mutate(
              { id: parseInt(tuneId), ...data },
              { onSuccess: () => navigate({ to: "/ac-evo/setups" }) },
            )
          }
          isSubmitting={updateTune.isPending}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/ac-evo/setups/edit/$tuneId")({
  component: EditAcEvoTunePage,
});
