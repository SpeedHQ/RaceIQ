import type { ComponentProps, ComponentType } from "react";
import type { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { UseQueryResult } from "@tanstack/react-query";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import type { RacePlanGeneration, RacePlanInput, SetActiveRacePlanInput } from "@raceiq/shared/racing/live/race-plan";
import type { TireThresholdOverrides } from "@raceiq/shared/racing/live/tire-thresholds";
import type { LiveTelemetryView } from "@raceiq/frontend-pure/live-telemetry-view";
import type { RaceStrategyMessages } from "./messages";

export interface RaceStrategyLiveState {
  telemetryView: LiveTelemetryView | null;
  sessionLaps: LapMeta[];
  serverStatus: { detectedGame: { id: string } | null; currentSession: { id: number } | null } | null;
}

/** Host retains inferred authenticated RPC; feature validates untrusted response bodies with shared schemas. */
export interface RaceStrategyApi {
  listPlans(gameId: GameId, signal?: AbortSignal): Promise<unknown>;
  activePlans(signal?: AbortSignal): Promise<unknown>;
  savePlan(input: RacePlanInput, id?: string): Promise<unknown>;
  deletePlan(id: string): Promise<unknown>;
  setActivePlan(input: SetActiveRacePlanInput): Promise<unknown>;
  recalculatePlan(id: string, generation: RacePlanGeneration): Promise<unknown>;
  stints(gameId: GameId, sessionId: number): Promise<unknown>;
  lapMetrics(gameId: GameId, sessionId: number): Promise<unknown>;
  estimates(gameId: GameId, sessionId: number, driverKey: string | null, cursor: string | null): Promise<unknown>;
  baseline(gameId: GameId, sessionId: number, stintId: string): Promise<unknown>;
  clearEstimates(gameId: GameId, sessionId: number, driverKey: string): Promise<unknown>;
}

export interface RaceStrategyHost {
  m: RaceStrategyMessages;
  api: RaceStrategyApi;
  useSessions(options?: { allGames?: boolean }): UseQueryResult<SessionMeta[], Error>;
  useSettings(): { displaySettings: { tireThresholdOverrides?: TireThresholdOverrides }; settingsLoaded: boolean };
  useTelemetryState<T>(selector: (state: RaceStrategyLiveState) => T): T;
  Input: ComponentType<ComponentProps<"input">>;
  Select: ComponentType<ComponentProps<"select">>;
  Textarea: ComponentType<ComponentProps<"textarea">>;
  Button: ComponentType<ButtonPrimitive.Props & {
    variant?: "app-ghost" | "app-primary" | "app-outline" | "outline";
    size?: "icon-sm" | "app-sm" | "app-md" | "sm";
  }>;
  Dialog: ComponentType<DialogPrimitive.Root.Props>;
  DialogContent: ComponentType<DialogPrimitive.Popup.Props & { size?: "lg" | "wide"; showCloseButton?: boolean }>;
  DialogHeader: ComponentType<ComponentProps<"div">>;
  DialogTitle: ComponentType<DialogPrimitive.Title.Props>;
  DialogDescription: ComponentType<DialogPrimitive.Description.Props>;
  DialogTrigger: ComponentType<DialogPrimitive.Trigger.Props>;
}
