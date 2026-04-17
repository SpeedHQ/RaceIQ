import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTelemetryStore } from "../../stores/telemetry";
import { useGameStore } from "../../stores/game";
import { fakeForzaPacket, fakeForzaDisplayPacket } from "../fakeData";
import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

export interface DashStoryOverrides {
  raw?: Partial<TelemetryPacket>;
  display?: Partial<DisplayPacket>;
  unitSystem?: "metric" | "imperial";
}

export function DashStoryDecorator({
  children,
  overrides,
}: {
  children: ReactNode;
  overrides?: DashStoryOverrides;
}) {
  const raw = { ...fakeForzaPacket, ...(overrides?.raw ?? {}) } as TelemetryPacket;
  const display = {
    ...fakeForzaDisplayPacket,
    ...(overrides?.raw ?? {}),
    ...(overrides?.display ?? {}),
  } as DisplayPacket;

  useTelemetryStore.setState({
    connected: true,
    rawPacket: raw,
    packet: display,
    isRaceOn: true,
    udpPps: 60,
    packetsPerSec: 60,
    unitSystem: overrides?.unitSystem ?? "metric",
  });
  useGameStore.setState({ gameId: "fm-2023" });

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ width: "100%", height: "100vh", background: "#000" }}>{children}</div>
    </QueryClientProvider>
  );
}
