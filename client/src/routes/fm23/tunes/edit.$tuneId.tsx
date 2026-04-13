import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { TuneForm } from "../../../components/TuneForm";
import { useUpdateTune } from "../../../hooks/queries";
import { client } from "../../../lib/rpc";

function EditTunePage() {
  const { tuneId } = Route.useParams();
  const navigate = useNavigate();
  const updateTune = useUpdateTune();

  const { data: tune, isLoading } = useQuery({
    queryKey: ["tune", tuneId],
    queryFn: () => client.api.tunes[":id"].$get({ param: { id: String(tuneId) } }).then((r) => r.json() as any),
  });

  if (isLoading) return <div className="p-4 text-app-text-muted text-sm">Loading tune...</div>;
  if (!tune) return <div className="p-4 text-app-text-muted text-sm">Tune not found</div>;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto">
      <TuneForm
        title={`Edit: ${tune.name}`}
        initialData={{
          name: tune.name,
          author: tune.author,
          carOrdinal: tune.carOrdinal,
          category: tune.category,
          description: tune.description,
          settings: tune.settings,
        }}
        onCancel={() => navigate({ to: "/fm23/tunes" })}
        onSubmit={(data) => updateTune.mutate({ id: parseInt(tuneId), ...data } as any, { onSuccess: () => navigate({ to: "/fm23/tunes" }) })}
        isSubmitting={updateTune.isPending}
      />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/fm23/tunes/edit/$tuneId")({
  component: EditTunePage,
});
