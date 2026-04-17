import {
  fakeForzaPacket,
  fakeForzaDisplayPacket,
  fakeSectors,
  fakePit,
  fakeSessionLaps,
} from "../stories/fakeData";
import { useTelemetryStore } from "../stores/telemetry";
import { useGameStore } from "../stores/game";
import type { TelemetryPacket } from "@shared/types";

const PREVIEW_RAW_PACKET = {
  ...fakeForzaPacket,
  BrakeTempFrontLeft: 380,
  BrakeTempFrontRight: 375,
  BrakeTempRearLeft: 240,
  BrakeTempRearRight: 238,
  TirePressureFrontLeft: 27.8,
  TirePressureFrontRight: 27.7,
  TirePressureRearLeft: 26.5,
  TirePressureRearRight: 26.4,
  f1: { ...(fakeForzaPacket.f1 ?? {}), totalLaps: 57 },
} as TelemetryPacket;

const PREVIEW_SERVER_STATUS = {
  udpPps: 60,
  isRaceOn: true,
  droppedPackets: 0,
  udpPort: 5300,
  detectedGame: { id: "fm-2023", name: "Forza Motorsport" },
  currentSession: { id: 2, carOrdinal: 1742, trackOrdinal: 7 },
};

/**
 * Seeds the telemetry + game stores with plausible fake data for rendering
 * dash previews in the catalogue iframe. The catalogue page owns the preview
 * state definition; individual dash routes just call this when running in
 * preview mode (determined by the `?preview=1` query param).
 *
 * Safe to call inside iframes because each iframe has its own Zustand
 * singleton — it never leaks into the parent catalogue page's stores.
 */
export function seedDashPreviewState() {
  useTelemetryStore.setState({
    connected: true,
    rawPacket: PREVIEW_RAW_PACKET,
    packet: fakeForzaDisplayPacket,
    sectors: fakeSectors,
    pit: fakePit,
    sessionLaps: fakeSessionLaps,
    isRaceOn: true,
    udpPps: 60,
    packetsPerSec: 60,
    unitSystem: "metric",
    serverStatus: PREVIEW_SERVER_STATUS,
  });
  useGameStore.setState({ gameId: "fm-2023" });
}

/** Read `?preview=1` from the current URL (SSR-safe). */
export function isPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("preview") === "1";
}
