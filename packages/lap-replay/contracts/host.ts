import type { OpponentLapReference, OpponentSemanticLapTelemetry } from "./opponents";
import type { ComponentType, Dispatch, SetStateAction } from "react";
import type { Button as BaseButton } from "@base-ui/react/button";
import type { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { GameId } from "@raceiq/shared/games/ids";
import type { SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";
import type { CarModelEnrichment } from "@raceiq/scene-3d/model-types";
import type { TrackBoundaries, Point } from "@raceiq/tracks-catalogue/contracts";
import type { SemanticLapTelemetry } from "./replay";
import type { ReplayMessages } from "./messages";
type OpponentReference = Extract<OpponentLapReference, { kind: "opponent" }>;

export type TrackMapBoundaries = TrackBoundaries & { centerLine: Point[]; raceLine?: Point[] | null; additionalSections?: { leftEdge: Point[]; rightEdge: Point[] }[] };
export type { Point } from "@raceiq/tracks-catalogue/contracts";
export interface ReplayLineSpread { fracs: number[]; spreadM: number[]; consistencyScore: number; overallSpreadM: number; lapCount: number }
export interface ReplayUnits { speed: (value: number) => number; speedLabel: string; temp: (value: number) => number; tempLabel: string }
export interface ReplayModelResources {
  loadCarModelConfigs: () => Promise<void>;
  resolveCarModelSelection: (gameId: GameId, carId: string | undefined) => { model: CarModelEnrichment & { hasModel: boolean }; label: "exact" | "generic" };
}
export interface ReplayDataProps {
  currentFrame: SemanticAnalysisFrame | null;
  packetNumber: number;
  startFuel: number | undefined;
  gameId: GameId;
  wearRate: { FL: number; FR: number; RL: number; RR: number } | null;
  estimatedSlipAngles?: readonly [number | null, number | null, number | null, number | null];
  angleDisclosure?: string;
}
export interface ReplayComparisonAiProps {
  lapA: { id: number; label: string; lapTime: number };
  lapB: { id: number; label: string; lapTime: number };
  panelOpen?: boolean;
  headerTarget?: HTMLDivElement | null;
  segments?: { name: string; startFrac: number; endFrac: number }[];
  onJumpToFrac?: (fraction: number) => void;
}
export type ReplayButtonProps = BaseButton.Props & { variant?: "plain" | "app-outline" | "app-ghost"; size?: "content" | "icon-xs" };
export type ReplayTabsProps = Omit<BaseTabs.Root.Props, "value" | "defaultValue" | "onValueChange"> & {
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string, details: BaseTabs.Root.ChangeEventDetails) => void;
};
export type ReplayTabsListProps = BaseTabs.List.Props & { variant?: "default" | "pills" | "underline" };
export type ReplayTabsTriggerProps = Omit<BaseTabs.Tab.Props, "value"> & { value: string; variant?: "default" | "pills" | "underline" };
export type ReplayTabsContentProps = Omit<BaseTabs.Panel.Props, "value"> & { value: string };
export interface ReplayHost {
  m: ReplayMessages;
  Button: ComponentType<ReplayButtonProps>;
  Tabs: ComponentType<ReplayTabsProps>;
  TabsList: ComponentType<ReplayTabsListProps>;
  TabsTrigger: ComponentType<ReplayTabsTriggerProps>;
  TabsContent: ComponentType<ReplayTabsContentProps>;
  Tooltip: ComponentType<BaseTooltip.Root.Props>;
  TooltipTrigger: ComponentType<BaseTooltip.Trigger.Props>;
  TooltipProvider: ComponentType<BaseTooltip.Provider.Props>;
  TooltipContent: ComponentType<BaseTooltip.Popup.Props & Pick<BaseTooltip.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">>;
  LoadingIndicator: ComponentType<{ label: string }>;
  TireDiagram: ComponentType<{ frame: SemanticAnalysisFrame; gameId: GameId; readable?: boolean }>;
  DataContent: ComponentType<ReplayDataProps>;
  CompareAiPanel: ComponentType<ReplayComparisonAiProps>;
  useSettings: () => { displaySettings: { renderFpsCap: number } };
  useUnits: (gameId?: GameId) => ReplayUnits;
  useTirePressureOptimal: (gameId: GameId, carId: string | undefined, enabled: boolean) => { min: number; max: number } | undefined;
  useLocalStorage: <T>(key: string, fallback: T) => [T, Dispatch<SetStateAction<T>>];
  useLapSemanticTelemetry: (id: number | null) => { data: SemanticLapTelemetry | undefined; error: Error | null; refetch: () => Promise<unknown> };
  useOpponentLapSemanticTelemetry: (reference: OpponentReference | null) => { data: OpponentSemanticLapTelemetry | undefined; error: Error | null; refetch: () => Promise<unknown> };
  useCompareLineSpread: (gameId: GameId, lapIds: readonly number[]) => { data: ReplayLineSpread | null | undefined };
  useTrackBoundaries: (id: string | undefined, gameId?: GameId) => { data: unknown };
  getLocale: () => string;
  formatLapTime: (seconds: number) => string;
  syncCanvasSize: (canvas: HTMLCanvasElement, width: number, height: number, requestedDpr?: number, setStyle?: boolean, maxDpr?: number, maxPixelArea?: number) => void;
  models: ReplayModelResources;
}
