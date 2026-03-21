import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuneForm } from "../../components/TuneForm";
import { useCreateTune } from "../../hooks/queries";

function NewTunePage() {
  const navigate = useNavigate();
  const createTune = useCreateTune();

  return (
    <div className="flex-1 overflow-auto p-4 max-w-xl mx-auto">
      <TuneForm
        title="Create New Tune"
        onCancel={() => navigate({ to: "/tunes" })}
        onSubmit={(data) => createTune.mutate(data as any, { onSuccess: () => navigate({ to: "/tunes" }) })}
        isSubmitting={createTune.isPending}
      />
    </div>
  );
}

export const Route = createFileRoute("/tunes/new")({
  component: NewTunePage,
});
