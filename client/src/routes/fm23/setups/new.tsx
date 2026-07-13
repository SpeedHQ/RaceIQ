import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuneForm } from "../../../components/TuneForm";
import { useCreateTune } from "../../../hooks/queries";

function NewTunePage() {
  const navigate = useNavigate();
  const createTune = useCreateTune();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <TuneForm
          title="Create New Tune"
          onCancel={() => navigate({ to: "/fm23/setups" })}
          onSubmit={(data) => createTune.mutate(data as any, { onSuccess: () => navigate({ to: "/fm23/setups" }) })}
          isSubmitting={createTune.isPending}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/fm23/setups/new")({
  component: NewTunePage,
});
