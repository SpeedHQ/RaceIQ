import { create } from "zustand";
import type { TelemetryPacket, LiveSectorData, LivePitData, LapMeta } from "@shared/types";
import { convertPacket, type DisplayPacket } from "../lib/convert-packet";

export interface DisplaySettings {
  unit: "metric" | "imperial";
  tireTempCelsiusThresholds: { cold: number; warm: number; hot: number };
  tireHealthThresholds: { values: number[] };
  suspensionThresholds: { values: number[] };
  aiProvider: "gemini" | "openai" | "local";
  aiModel: string;
  chatProvider: "gemini" | "openai" | "local";
  chatModel: string;
  localEndpoint: string;
  wsRefreshRate: string;
  /** Server-injected: current UDP port */
  udpPort?: number;
  /** Server-injected: whether a Gemini API key is stored */
  geminiApiKeySet?: boolean;
  /** Server-injected: whether an OpenAI API key is stored */
  openaiApiKeySet?: boolean;
  /** Server-injected: whether an Anthropic API key is stored */
  anthropicApiKeySet?: boolean;
  /** Driver display name */
  driverName?: string;
  /** Whether the user has completed onboarding */
  onboardingComplete?: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  unit: "metric",
  tireTempCelsiusThresholds: { cold: 75, warm: 115, hot: 150 },
  tireHealthThresholds: { values: [20, 40, 60, 80] },
  suspensionThresholds: { values: [25, 65, 85] },
  aiProvider: "gemini",
  aiModel: "",
  chatProvider: "gemini",
  chatModel: "",
  localEndpoint: "http://localhost:1234/v1",
  wsRefreshRate: "60",
};

export interface ReleaseInfo {
  version: string;
  notes: string;
  date: string;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  newReleases: ReleaseInfo[];
  currentReleaseNotes: string | null;
  currentReleaseDate: string | null;
  lastChecked: string | null;
  checked: boolean;
}

export interface ServerStatus {
  udpPps: number;
  isRaceOn: boolean;
  droppedPackets: number;
  udpPort: number;
  detectedGame: { id: string; name: string } | null;
  currentSession: { id: number; carOrdinal: number; trackOrdinal: number } | null;
}

interface TelemetryState {
  connected: boolean;
  /** Raw packet from WebSocket (unchanged, for calculations) */
  rawPacket: TelemetryPacket | null;
  /** Display-converted packet (speed/temp in user units) */
  packet: DisplayPacket | null;
  packetsPerSec: number;
  /** Full server status pushed via WebSocket */
  serverStatus: ServerStatus | null;
  /** UDP packets/sec reported by server (includes non-race packets) */
  udpPps: number;
  /** Whether the game is actively in a race session */
  isRaceOn: boolean;
  /** Timestamp of last UDP activity (for grace period) */
  lastUdpAt: number;
  /** Server-computed live sector data */
  sectors: LiveSectorData | null;
  /** Server-computed pit strategy data */
  pit: LivePitData | null;
  /** Current unit system */
  unitSystem: "metric" | "imperial";
  /** Version string if a server update is available, null otherwise */
  updateAvailable: string | null;
  /** Update progress tracking */
  updateProgress: { stage: "downloading" | "installing" | "reconnecting" | "complete"; percent: number } | null;
  /** Cached version info from /api/version */
  versionInfo: VersionInfo | null;
  /** Server-pushed recorded laps for the current session's track+car */
  sessionLaps: LapMeta[];
  setConnected: (connected: boolean) => void;
  setPacket: (packet: TelemetryPacket) => void;
  setSectors: (sectors: LiveSectorData) => void;
  setPit: (pit: LivePitData) => void;
  clearPacket: () => void;
  setPacketsPerSec: (pps: number) => void;
  setServerStatus: (status: ServerStatus | null) => void;
  setSessionLaps: (laps: LapMeta[]) => void;
  setUpdateAvailable: (version: string | null) => void;
  setUpdateProgress: (progress: TelemetryState["updateProgress"]) => void;
  setVersionInfo: (info: VersionInfo) => void;
  devState: unknown | null;
  devStatePaused: boolean;
  setDevState: (state: unknown) => void;
  toggleDevStatePause: () => void;
  /** Update unit system — re-converts current packet */
  setUnitSystem: (unit: "metric" | "imperial") => void;
}

function speedUnit(u: "metric" | "imperial") { return u === "metric" ? "kmh" as const : "mph" as const; }
function tempUnit(u: "metric" | "imperial") { return u === "metric" ? "C" as const : "F" as const; }

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  connected: false,
  rawPacket: null,
  packet: null,
  sectors: null,
  pit: null,
  packetsPerSec: 0,
  serverStatus: null,
  udpPps: 0,
  isRaceOn: false,
  lastUdpAt: 0,
  unitSystem: "metric",
  updateAvailable: null,
  updateProgress: null,
  versionInfo: null,
  sessionLaps: [],
  devState: null,
  devStatePaused: false,
  setConnected: (connected) => set((prev) => {
    // Detect reconnection after update install
    if (connected && prev.updateProgress?.stage === "reconnecting") {
      return { connected, updateProgress: { stage: "complete", percent: 100 }, updateAvailable: null };
    }
    return { connected };
  }),
  setSectors: (sectors) => set({ sectors }),
  setPit: (pit) => set({ pit }),
  setSessionLaps: (sessionLaps) => set({ sessionLaps }),
  setPacket: (raw) => {
    const { unitSystem } = get();
    set({
      rawPacket: raw,
      packet: convertPacket(raw, speedUnit(unitSystem), tempUnit(unitSystem)),
    });
  },
  clearPacket: () => set({ rawPacket: null, packet: null }),
  setPacketsPerSec: (packetsPerSec) => set({ packetsPerSec }),
  setServerStatus: (status: ServerStatus | null) => set(status ? {
    serverStatus: status,
    udpPps: status.udpPps,
    isRaceOn: status.isRaceOn,
    lastUdpAt: status.udpPps > 0 ? Date.now() : get().lastUdpAt,
  } : {
    serverStatus: null,
    udpPps: 0,
    isRaceOn: false,
  }),
  setUpdateAvailable: (version) => set({ updateAvailable: version }),
  setUpdateProgress: (progress) => set({ updateProgress: progress }),
  setVersionInfo: (info) => set({ versionInfo: info }),
  setDevState: (state) => {
    if (get().devStatePaused) return;
    set({ devState: state });
  },
  toggleDevStatePause: () => set((prev) => ({ devStatePaused: !prev.devStatePaused })),
  setUnitSystem: (unit) => {
    const { rawPacket } = get();
    set({
      unitSystem: unit,
      packet: rawPacket ? convertPacket(rawPacket, speedUnit(unit), tempUnit(unit)) : null,
    });
  },
}));
