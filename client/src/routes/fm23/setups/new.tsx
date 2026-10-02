import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { m } from "@/paraglide/messages";
import { TuneForm } from "@/components/tune/form/TuneForm";
import { useCreateTune } from "@/hooks/tunes";

function NewTunePage() {
  const navigate = useNavigate();
  const createTune = useCreateTune();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <TuneForm
          title={m.setup_create_tune_title()}
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
