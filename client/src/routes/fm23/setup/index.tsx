import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { WheelCatalogue } from "../../../components/HardwareSetup";

function SetupIndex() {
  const navigate = useNavigate();
  return <WheelCatalogue onSelect={(profileId) => navigate({ to: "/fm23/setup/$profileId", params: { profileId } })} />;
}

export const Route = createFileRoute("/fm23/setup/")({
  component: SetupIndex,
});
