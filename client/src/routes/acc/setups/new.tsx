import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { m } from "@/paraglide/messages";
import { SetupTuneForm } from "../../../components/setup-tune/SetupTuneForm";
import { useCreateTune } from "../../../hooks/tunes";

function NewAccTunePage() {
  const navigate = useNavigate();
  const createTune = useCreateTune();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <SetupTuneForm
          gameId="acc"
          title={m.setup_create_acc_tune_title()}
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
