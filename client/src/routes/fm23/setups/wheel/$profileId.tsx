import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { HardwareSetupDetail } from "../../../../components/HardwareSetup";

function WheelProfile() {
  const { profileId } = Route.useParams();
  const navigate = useNavigate();
  return <HardwareSetupDetail profileId={profileId} onBack={() => navigate({ to: "/fm23/setups/wheel" })} />;
}

export const Route = createFileRoute("/fm23/setups/wheel/$profileId")({
  component: WheelProfile,
});
