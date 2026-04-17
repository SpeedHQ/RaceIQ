import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTelemetryStore } from "../../stores/telemetry";
import { useGameStore } from "../../stores/game";
import {
  fakeForzaPacket,
  fakeForzaDisplayPacket,
  fakeSectors,
  fakePit,
  fakeSessionLaps,
} from "../fakeData";
import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

export interface DashStoryOverrides {
  raw?: Partial<TelemetryPacket>;
  display?: Partial<DisplayPacket>;
  unitSystem?: "metric" | "imperial";
  /** Race total laps (simulates F1/ACC race context). */
  totalLaps?: number;
}

export function DashStoryDecorator({
  children,
  overrides,
}: {
  children: ReactNode;
  overrides?: DashStoryOverrides;
}) {
  const brakeAndPsiDefaults = {
    BrakeTempFrontLeft: 380,
    BrakeTempFrontRight: 375,
    BrakeTempRearLeft: 240,
    BrakeTempRearRight: 238,
    TirePressureFrontLeft: 27.8,
    TirePressureFrontRight: 27.7,
    TirePressureRearLeft: 26.5,
    TirePressureRearRight: 26.4,
  };
  const rawBase = {
    ...fakeForzaPacket,
    ...brakeAndPsiDefaults,
    ...(overrides?.raw ?? {}),
  } as TelemetryPacket;
  const totalLapsValue = overrides?.totalLaps ?? 57;
  const raw = {
    ...rawBase,
    f1: { ...(rawBase.f1 ?? {}), totalLaps: totalLapsValue },
  } as TelemetryPacket;
  const display = {
    ...fakeForzaDisplayPacket,
    ...(overrides?.raw ?? {}),
    ...(overrides?.display ?? {}),
  } as DisplayPacket;

  useTelemetryStore.setState({
    connected: true,
    rawPacket: raw,
    packet: display,
    sectors: fakeSectors,
    pit: fakePit,
    sessionLaps: fakeSessionLaps,
    isRaceOn: true,
    udpPps: 60,
    packetsPerSec: 60,
    unitSystem: overrides?.unitSystem ?? "metric",
    serverStatus: {
      udpPps: 60,
      isRaceOn: true,
      droppedPackets: 0,
      udpPort: 5300,
      detectedGame: { id: "fm-2023", name: "Forza Motorsport" },
      currentSession: { id: 2, carOrdinal: 1742, trackOrdinal: 7 },
    },
  });
  useGameStore.setState({ gameId: "fm-2023" });

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ width: "100%", height: "100vh", background: "#000" }}>{children}</div>
    </QueryClientProvider>
  );
}
