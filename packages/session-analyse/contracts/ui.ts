import type { ComponentProps, ComponentType } from "react";
import type { Button as BaseButton } from "@base-ui/react/button";
import type { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import type { TuneIssue } from "@raceiq/shared/racing/tuning/issues";
import type { VersionKind } from "@raceiq/shared/racing/experiments/focus";
import type { AlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/types";
import type { SemanticTuneSample, TuneWheelMetric } from "@raceiq/analysis-core/racing/laps/semantic-tune";
import type { LineSpreadTrace } from "@raceiq/analysis-core/racing/laps/consistency-types";
import type { BrakeTempThresholds } from "@raceiq/scene-3d/vehicle-dynamics";
import type { TuneReviewTrackTab } from "./search";
import type { SessionAnalyseMessages } from "./messages";

export type MetricKey = "tireSurfaceTemp" | "tireCoreTemp" | "tireCarcassTemp" | "brakeTemp" | "pressure" | "wear";
export type CornerKey = "FL" | "FR" | "RL" | "RR";
export interface MetricDef { key: MetricKey; label: string; unit: string; quantity?: "temperature"; accent: string; semantic?: boolean; field: TuneWheelMetric }
export interface SectorTimes { times: number[]; boundaryIndices: number[] }
export interface Range { min: number; avg: number; max: number; n: number }
export interface SectorRangeModel { sectors: Record<CornerKey, Range>[]; domain: [number, number] }
export interface ReviewExperiment { kind: VersionKind; experimentId: number; driverComment?: string | null; notes?: string | null }
interface TireSnapshot { tempC?: number; coreTempC?: number; carcassTempC?: number; wear?: number; pressure?: number; brakeTemp?: number }
interface QueryState<T> { data?: T; isLoading: boolean; isError: boolean; refetch: () => Promise<unknown> }

export interface SessionAnalyseHost {
  m: SessionAnalyseMessages;
  Button: ComponentType<BaseButton.Props & { variant?: "app-outline" | "app-primary" | "app-ghost" | "close-action"; size?: "app-sm" | "icon-sm" }>;
  Badge: ComponentType<ComponentProps<"span"> & { variant?: "warning" | "info" | "success" | "danger"; size?: "compact" }>;
  Dialog: ComponentType<BaseDialog.Root.Props>;
  DialogContent: ComponentType<BaseDialog.Popup.Props & { size?: "wide"; showCloseButton?: boolean; overlayClassName?: string }>;
  DialogDescription: ComponentType<BaseDialog.Description.Props>;
  DialogFooter: ComponentType<ComponentProps<"div">>;
  DialogHeader: ComponentType<ComponentProps<"div">>;
  DialogTitle: ComponentType<BaseDialog.Title.Props>;
  SearchSelect: ComponentType<{ value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; ariaLabel?: string; className?: string }>;
  LapAnalyse: ComponentType<{ sessionId?: number }>;
  TireGrid: ComponentType<{
    title?: string;
    corners: Record<CornerKey, TireSnapshot>;
    healthThresholds: { green: number; yellow: number };
    tempThresholds: { blue: number; orange: number; red: number };
    pressureOptimal?: { min: number; max: number };
    brakeTempThresholds?: BrakeTempThresholds;
    healthAvailable?: boolean;
  }>;
  SectorMap: ComponentType<{
    gameId?: GameId; telemetry: SemanticTuneSample[]; sectorTimes: SectorTimes | null; showTimes?: boolean; trackId?: string;
    issueMarkers?: { fraction: number; color: string }[];
    readout?: (frame: SemanticTuneSample, fraction: number) => { label: string; value: string; color?: string }[];
    onHover?: (index: number | null) => void; markFraction?: number | null;
  }>;
  SectorDetailView: ComponentType<{ gameId?: GameId; telemetry: SemanticTuneSample[]; sectorTimes: SectorTimes | null; sectorIndex: number; trackId?: string; issues: TuneIssue[] }>;
  TrackFocusView: ComponentType<{
    gameId: GameId; alignedSet: AlignedLapSet | undefined; lapIds: readonly number[]; trackId?: string; primaryLapId: number;
    experimentId?: number | null; activeTab?: TuneReviewTrackTab; lineSpreadOverride?: LineSpreadTrace | null; onActiveTabChange?: (tab: TuneReviewTrackTab) => void;
  }>;
  IssuePill: ComponentType<{ issue: TuneIssue; onHover?: (fraction: number | null) => void }>;
  CornerBars: ComponentType<{ ranges: Record<CornerKey, Range>; domain: [number, number]; metric: MetricDef; cursor?: Partial<Record<CornerKey, number>>; tempLabel?: string; temperatureUnit?: "C" | "F" }>;
  CORNERS: readonly CornerKey[];
  METRICS: readonly MetricDef[];
  bandColor: (value: number) => string;
  buildSectorRanges: (telemetry: SemanticTuneSample[], sectorTimes: SectorTimes | null, metric: MetricDef) => SectorRangeModel | null;
  sectorIndexForTelemetryIndex: (index: number, boundaries: readonly number[], count: number) => number;
  metricDisplayValue: (metric: MetricDef, value: number, temperatureUnit: "C" | "F") => number;
  tuneMetricValue: (sample: SemanticTuneSample, metric: MetricDef, index: number) => number | undefined;
  tuneMetricsFor: (telemetry: readonly SemanticTuneSample[]) => MetricDef[];
  useGameId: () => GameId | null;
  useSessions: () => QueryState<SessionMeta[]>;
  useSessionLaps: (sessionId: number | null) => QueryState<LapMeta[]>;
  useAlignedTelemetry: (lapIds: readonly number[], request: { step: 1 } | { step: 0.1; start: number; end: number } | null) => QueryState<AlignedLapSet>;
  useLapIssues: (lapId: number | null) => { data?: TuneIssue[] };
  useTirePressureOptimal: (gameId: GameId, carId: string | undefined) => { min: number; max: number } | undefined;
  useUnits: (gameId?: GameId) => { temp: (celsius: number) => number; tempLabel: string; temperatureUnit: "C" | "F" };
  useCarName: (carId: string | undefined) => QueryState<string>;
  useTrackName: (trackId: string | undefined) => QueryState<string>;
  useResolveNames: (trackIds: string[], carIds: string[]) => QueryState<{ trackNames: Record<string, string>; carNames: Record<string, string> }>;
  fetchReviewLaps: (gameId: GameId, trackId: string, carId: string, limit: number) => Promise<LapMeta[]>;
  fetchSessionLineSpread: (gameId: GameId, sessionId: number, lapIds: readonly number[]) => Promise<LineSpreadTrace>;
  getGameRoute: (gameId: GameId) => string;
  formatLapTime: (seconds: number) => string;
}
