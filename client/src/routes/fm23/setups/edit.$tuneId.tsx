import type { TuneSettings } from "@shared/racing/tuning/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuneForm, type TuneFormData } from "@/components/tune/form/TuneForm";
import { useUpdateTune } from "@/hooks/tunes";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

interface TuneResponse {
  id: number;
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  description: string;
  settings: TuneSettings | null;
  unitSystem: string;
}

function EditTunePage() {
  const { tuneId } = Route.useParams();
  const navigate = useNavigate();
  const updateTune = useUpdateTune();

  const { data: tune, isLoading } = useQuery({
    queryKey: ["tune", tuneId],
    queryFn: () => client.api.tunes[":id"].$get({ param: { id: String(tuneId) } }).then((r) => r.json() as unknown as TuneResponse),
  });

  if (isLoading) return <div className="p-4 text-app-text-muted text-sm">{m.tuneedit_loading()}</div>;
  if (!tune) return <div className="p-4 text-app-text-muted text-sm">{m.tuneedit_not_found()}</div>;

  const initialData: Partial<TuneFormData> = {
    name: tune.name,
    author: tune.author,
    carOrdinal: tune.carOrdinal,
    category: tune.category as TuneFormData["category"],
    description: tune.description,
    settings: tune.settings ?? undefined,
    unitSystem: tune.unitSystem === "imperial" ? "imperial" : "metric",
  };

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-6xl mx-auto">
        <TuneForm
          title={`Edit: ${tune.name}`}
          initialData={initialData}
          onCancel={() => navigate({ to: "/fm23/setups" })}
          onSubmit={(data) =>
            updateTune.mutate({ id: parseInt(tuneId, 10), ...data } as Parameters<typeof updateTune.mutate>[0], {
              onSuccess: () => navigate({ to: "/fm23/setups" }),
            })
          }
          isSubmitting={updateTune.isPending}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/fm23/setups/edit/$tuneId")({
  component: EditTunePage,
});
