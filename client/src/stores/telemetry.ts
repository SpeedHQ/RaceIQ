import { create } from "zustand";
import { advanceReprocess, beginReprocess, completeReprocess, dismissReprocess, failReprocess, initialReprocessState, type ReprocessState } from "@/lib/reprocess-state";
import type { LivePitData, LiveSectorData } from "../../../shared/racing/live/types";
import type { EligibilityDecision } from "../../../shared/racing/quality/contracts";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import type { TuneIssue } from "../../../shared/racing/tuning/issues";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../../shared/telemetry/live/contracts";
import type { LiveTelemetryView } from "../lib/live-telemetry-view";
import { buildLiveTelemetryView } from "../lib/live-telemetry-view";
export interface DisplaySettings {
  unit: "metric" | "imperial";
  temperatureUnit: "C" | "F";
  aiProvider: "gemini" | "openai" | "local";
  aiModel: string;
  aiThinkingBudget: number | null;
  chatProvider: "gemini" | "openai" | "local";
  chatModel: string;
  chatThinkingBudget: number | null;
  autoTuneProvider: "gemini" | "openai" | "local";
  autoTuneModel: string;
  localEndpoint: string;
  wsRefreshRate: string;
  /** Max 3D Canvas render rate for the analyse wireframe (15–120 fps). */
  renderFpsCap: number;
  /** Max in-memory parsed-lap cache, in megabytes. */
  cacheMaxMB: number;
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
  /** Game IDs excluded from nav and home page */
  hiddenGames?: string[];
  /** Whether to launch RaceIQ automatically on Windows login */
  launchOnLogin?: boolean;
  /** UI + AI output language (ISO code, e.g. "en", "de"). */
  language?: string;
  /** True when running as compiled exe, false in dev (bun run dev) */
  isCompiled?: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  unit: "metric",
  temperatureUnit: "C",
  aiProvider: "gemini",
  aiModel: "",
  aiThinkingBudget: null,
  chatProvider: "gemini",
  chatModel: "",
  chatThinkingBudget: null,
  autoTuneProvider: "gemini",
  autoTuneModel: "",
  localEndpoint: "http://localhost:1234/v1",
  wsRefreshRate: "60",
  renderFpsCap: 60,
  cacheMaxMB: 256,
  language: "en",
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
  fullReleaseNotes: string | null;
  currentReleaseNotes: string | null;
  currentReleaseDate: string | null;
  lastChecked: string | null;
  checked: boolean;
}

export interface ServerStatus {
  udpPps: number;
  /** Telemetry packets/sec accepted by the common live pipeline. */
  telemetryPps: number;
  isRaceOn: boolean;
  droppedPackets: number;
  udpPort: number;
  detectedGame: { id: string; name: string } | null;
  currentSession: {
    id: number;
    carOrdinal: number;
    trackOrdinal: number;
  } | null;
}

interface TelemetryState {
  connected: boolean;
  telemetrySchema: LiveTelemetrySchemaMessageV1 | null;
  telemetryFrame: LiveTelemetryFrameMessageV1 | null;
  telemetryView: LiveTelemetryView | null;
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
  /** Current speed/distance unit system */
  unitSystem: "metric" | "imperial";
  /** Current temperature unit */
  temperatureUnit: "C" | "F";
  /** Version string if a server update is available, null otherwise */
  updateAvailable: string | null;
  /** Update progress tracking */
  updateProgress: {
    stage: "downloading" | "installing" | "reconnecting" | "complete";
    percent: number;
  } | null;
  /** Cached version info from /api/version */
  versionInfo: VersionInfo | null;
  /** Server-pushed recorded laps for the current session's track+car */
  sessionLaps: LapMeta[];
  /** Stale race-result notification — null if current or dismissed */
  staleRaceResults: { sessionCount: number; currentVersion: string } | null;
  /** Active race-result reconciliation progress */
  raceResultReprocessProgress: { done: number; total: number } | null;
  /** Race-result reconciliation error, if the latest attempt failed */
  raceResultReprocessError: string | null;
  staleLapDetection: { sessionCount: number; currentVersion: string } | null;
  /** Stale-session reprocessing request and dialog state */
  reprocessState: ReprocessState;
  /** Live Tuning Dashboard: transient per-packet issues from the latest broadcast
   *  (only populated while `POST /api/live-analysis {enabled:true}` is active). */
  liveIssues: TuneIssue[];
  /** Live Tuning Dashboard: per-lap issue feed, most recent lap first. */
  lapIssuesFeed: { lapId: number; lapNumber: number; issues: TuneIssue[]; eligibility: EligibilityDecision }[];
  setConnected: (connected: boolean) => void;
  setTelemetrySchema: (schema: LiveTelemetrySchemaMessageV1) => void;
  setTelemetryFrame: (frame: LiveTelemetryFrameMessageV1) => void;
  setSectors: (sectors: LiveSectorData) => void;
  setPit: (pit: LivePitData) => void;
  setLiveIssues: (issues: TuneIssue[]) => void;
  addLapIssues: (entry: { lapId: number; lapNumber: number; issues: TuneIssue[]; eligibility: EligibilityDecision }) => void;
  clearTelemetry: () => void;
  setPacketsPerSec: (pps: number) => void;
  setServerStatus: (status: ServerStatus | null) => void;
  setSessionLaps: (laps: LapMeta[]) => void;
  setUpdateAvailable: (version: string | null) => void;
  setUpdateProgress: (progress: TelemetryState["updateProgress"]) => void;
  setVersionInfo: (info: VersionInfo) => void;
  setStaleRaceResults: (data: { sessionCount: number; currentVersion: string } | null) => void;
  setRaceResultReprocessProgress: (progress: { done: number; total: number } | null) => void;
  setRaceResultReprocessError: (error: string | null) => void;
  setStaleLapDetection: (data: { sessionCount: number; currentVersion: string } | null) => void;
  beginReprocess: (total: number) => void;
  completeReprocess: () => void;
  failReprocess: (message: string) => void;
  dismissReprocess: () => void;
  incrementReprocessProgress: () => void;
  devState: unknown | null;
  devStatePaused: boolean;
  setDevState: (state: unknown) => void;
  toggleDevStatePause: () => void;
  /** Update display units for semantic telemetry rendering. */
  setDisplayUnits: (unit: "metric" | "imperial", temperatureUnit: "C" | "F") => void;
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  connected: false,
  telemetrySchema: null,
  telemetryFrame: null,
  telemetryView: null,
  sectors: null,
  pit: null,
  packetsPerSec: 0,
  serverStatus: null,
  udpPps: 0,
  isRaceOn: false,
  lastUdpAt: 0,
  unitSystem: "metric",
  temperatureUnit: "C",
  updateAvailable: null,
  updateProgress: null,
  versionInfo: null,
  sessionLaps: [],
  staleRaceResults: null,
  raceResultReprocessProgress: null,
  raceResultReprocessError: null,
  staleLapDetection: null,
  reprocessState: initialReprocessState,
  liveIssues: [],
  lapIssuesFeed: [],
  devState: null,
  devStatePaused: false,
  setConnected: (connected) =>
    set((prev) => {
      // Detect reconnection after update install
      if (connected && prev.updateProgress?.stage === "reconnecting") {
        return {
          connected,
          updateProgress: { stage: "complete", percent: 100 },
          updateAvailable: null,
        };
      }
      return { connected };
    }),
  setSectors: (sectors) => set({ sectors }),
  setPit: (pit) => set({ pit }),
  setSessionLaps: (sessionLaps) => set({ sessionLaps }),
  setLiveIssues: (liveIssues) => set({ liveIssues }),
  addLapIssues: (entry) =>
    set((prev) => ({
      // Most-recent-first, capped so a long practice session doesn't grow unbounded.
      lapIssuesFeed: [entry, ...prev.lapIssuesFeed.filter((e) => e.lapId !== entry.lapId)].slice(0, 20),
    })),
  setTelemetrySchema: (telemetrySchema) =>
    set((prev) =>
      prev.telemetrySchema?.schemaId === telemetrySchema.schemaId ? { telemetrySchema } : { telemetrySchema, telemetryFrame: null, telemetryView: null, sectors: null, pit: null, liveIssues: [] },
    ),
  setTelemetryFrame: (telemetryFrame) =>
    set((prev) => {
      const context = telemetryFrame.context ?? {};
      return {
        telemetryFrame,
        telemetryView: prev.telemetrySchema ? (buildLiveTelemetryView(prev.telemetrySchema, telemetryFrame) ?? prev.telemetryView) : prev.telemetryView,
        sectors: context.sectors ?? null,
        pit: context.pit ?? null,
        liveIssues: context.liveIssues ? [...context.liveIssues] : [],
      };
    }),
  clearTelemetry: () => set({ telemetryFrame: null, telemetryView: null, telemetrySchema: null, sectors: null, pit: null, liveIssues: [] }),
  setPacketsPerSec: (packetsPerSec) => set({ packetsPerSec }),
  setServerStatus: (status: ServerStatus | null) =>
    set(
      status
        ? {
            serverStatus: status,
            udpPps: status.udpPps,
            isRaceOn: status.isRaceOn,
            lastUdpAt: status.udpPps > 0 ? Date.now() : get().lastUdpAt,
          }
        : {
            serverStatus: null,
            udpPps: 0,
            isRaceOn: false,
          },
    ),
  setUpdateAvailable: (version) => set({ updateAvailable: version }),
  setStaleRaceResults: (data) => set({ staleRaceResults: data }),
  setRaceResultReprocessProgress: (progress) => set({ raceResultReprocessProgress: progress }),
  incrementRaceResultReprocessProgress: () =>
    set((prev) => (prev.raceResultReprocessProgress ? { raceResultReprocessProgress: { ...prev.raceResultReprocessProgress, done: prev.raceResultReprocessProgress.done + 1 } } : {})),
  setRaceResultReprocessError: (error) => set({ raceResultReprocessError: error }),
  setStaleLapDetection: (data) => set({ staleLapDetection: data }),
  beginReprocess: (total) => set((prev) => ({ reprocessState: beginReprocess(prev.reprocessState, total) })),
  completeReprocess: () => set((prev) => ({ reprocessState: completeReprocess(prev.reprocessState) })),
  failReprocess: (message) => set((prev) => ({ reprocessState: failReprocess(prev.reprocessState, message) })),
  dismissReprocess: () => set((prev) => ({ reprocessState: dismissReprocess(prev.reprocessState) })),
  incrementReprocessProgress: () =>
    set((prev) => ({
      reprocessState: advanceReprocess(prev.reprocessState),
    })),
  setUpdateProgress: (progress) => set({ updateProgress: progress }),
  setVersionInfo: (info) => set({ versionInfo: info }),
  setDevState: (state) => {
    if (get().devStatePaused) return;
    set({ devState: state });
  },
  toggleDevStatePause: () => set((prev) => ({ devStatePaused: !prev.devStatePaused })),
  setDisplayUnits: (unit, temperatureUnit) => set({ unitSystem: unit, temperatureUnit }),
}));
