import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { WheelCatalogue } from "../../../../components/HardwareSetup";

function WheelCatalogueIndex() {
  const navigate = useNavigate();
  return <WheelCatalogue onSelect={(profileId) => navigate({ to: "/fm23/setups/wheel/$profileId", params: { profileId } })} />;
}

export const Route = createFileRoute("/fm23/setups/wheel/")({
  component: WheelCatalogueIndex,
});
