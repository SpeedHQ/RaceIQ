import { createFileRoute } from "@tanstack/react-router";
import { StreamOverlay } from "@/components/streaming/StreamOverlay";
import { useOverlayData } from "@/hooks/useOverlayData";
import { parseOverlayConfig } from "@/lib/streaming-config";

function OverlayRoute() {
  const config = Route.useSearch();
  const data = useOverlayData(config);
  return <StreamOverlay config={config} data={data} />;
}

export const Route = createFileRoute("/overlay")({ validateSearch: parseOverlayConfig, component: OverlayRoute });
