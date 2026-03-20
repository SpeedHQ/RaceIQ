import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { HardwareSetupDetail } from "../../components/HardwareSetup";

function SetupProfile() {
  const { profileId } = Route.useParams();
  const navigate = useNavigate();
  return (
    <HardwareSetupDetail
      profileId={profileId}
      onBack={() => navigate({ to: "/setup" })}
    />
  );
}

export const Route = createFileRoute("/setup/$profileId")({
  component: SetupProfile,
});
