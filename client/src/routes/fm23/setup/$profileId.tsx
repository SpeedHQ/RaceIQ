import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { HardwareSetupDetail } from "../../../components/HardwareSetup";

function SetupProfile() {
  const { profileId } = Route.useParams();
  const navigate = useNavigate();
  return <HardwareSetupDetail profileId={profileId} onBack={() => navigate({ to: "/fm23/setup" })} />;
}

export const Route = createFileRoute("/fm23/setup/$profileId")({
  component: SetupProfile,
});
