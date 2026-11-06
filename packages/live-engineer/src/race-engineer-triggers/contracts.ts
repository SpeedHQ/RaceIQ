import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryVariableId } from "@raceiq/shared/telemetry/catalog/generated/telemetry-catalog.types";
import { RACE_ENGINEER_REFERENCE, type RaceEngineerEventFamily, type RaceEngineerSourceRef } from "@raceiq/shared/telemetry/live/race-engineer-callout-contract";
import type { LiveResolvedSemanticFrame } from "@raceiq/telemetry-core/telemetry/live-projector";
import type { RaceEngineerTriggerFrame } from "./frame";

export type RaceEngineerTriggerScalarV1 = string | number | boolean | null;
export type RaceEngineerTriggerValueV1 = RaceEngineerTriggerScalarV1 | readonly RaceEngineerTriggerScalarV1[];
export interface RaceEngineerTriggerDraftV1 { eventKey: string; severity: "critical" | "warning" | "info"; subjectId?: string; payload: Readonly<Record<string, RaceEngineerTriggerValueV1>>; evidenceSemanticIds: readonly TelemetryVariableId[]; }
export interface RaceEngineerTriggerEventV1 extends RaceEngineerTriggerDraftV1 { triggerId: string; family: RaceEngineerEventFamily; sessionId: string; timelineEpoch: number; sourceSequence: number; sessionTimeMs: number; source: RaceEngineerSourceRef; }
export interface RaceEngineerTriggerContextV1 { simulator: GameId; sessionActive: boolean; formation: boolean; caution: boolean; pit: boolean; spectating: boolean; }
export interface RaceEngineerTriggerBatchV1 { streamId: string; sessionId: string; timelineEpoch: number; sourceSequence: number; sessionTimeMs: number; context: RaceEngineerTriggerContextV1; events: readonly RaceEngineerTriggerEventV1[]; readonly semanticFrame?: LiveResolvedSemanticFrame; }
export type RaceEngineerTriggerResultV1 = RaceEngineerTriggerDraftV1 | readonly RaceEngineerTriggerDraftV1[] | null;
export interface RaceEngineerTriggerInputV1 { frame: RaceEngineerTriggerFrame; context: RaceEngineerTriggerContextV1; sessionTimeMs: number; }
export type RaceEngineerTriggerFunction<S> = (input: RaceEngineerTriggerInputV1, state: S) => RaceEngineerTriggerResultV1;
export const raceEngineerSource = (family: RaceEngineerEventFamily): RaceEngineerSourceRef => ({ ...(RACE_ENGINEER_REFERENCE), path: `CrewChiefV4/Events/${family}.cs`, symbols: [family === "Spotter" || family === "SessionEndMessages" ? "trigger" : "triggerInternal"] });
