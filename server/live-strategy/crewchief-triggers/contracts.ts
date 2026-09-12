import type { GameId } from "../../../shared/games/ids";
import type { TelemetryVariableId } from "../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import { CREWCHIEF_REFERENCE, type CrewChiefEventFamily, type CrewChiefSourceRef } from "../../../shared/telemetry/live/crewchief-callout-contract";
import type { LiveResolvedSemanticFrame } from "../../telemetry/live-projector";
import type { CrewChiefTriggerFrame } from "./frame";

export type CrewChiefTriggerScalarV1 = string | number | boolean | null;
export type CrewChiefTriggerValueV1 = CrewChiefTriggerScalarV1 | readonly CrewChiefTriggerScalarV1[];
export interface CrewChiefTriggerDraftV1 { eventKey: string; severity: "critical" | "warning" | "info"; subjectId?: string; payload: Readonly<Record<string, CrewChiefTriggerValueV1>>; evidenceSemanticIds: readonly TelemetryVariableId[]; }
export interface CrewChiefTriggerEventV1 extends CrewChiefTriggerDraftV1 { triggerId: string; family: CrewChiefEventFamily; sessionId: string; timelineEpoch: number; sourceSequence: number; sessionTimeMs: number; source: CrewChiefSourceRef; }
export interface CrewChiefTriggerContextV1 { simulator: GameId; sessionActive: boolean; formation: boolean; caution: boolean; pit: boolean; spectating: boolean; }
export interface CrewChiefTriggerBatchV1 { streamId: string; sessionId: string; timelineEpoch: number; sourceSequence: number; sessionTimeMs: number; context: CrewChiefTriggerContextV1; events: readonly CrewChiefTriggerEventV1[]; readonly semanticFrame?: LiveResolvedSemanticFrame; }
export type CrewChiefTriggerResultV1 = CrewChiefTriggerDraftV1 | readonly CrewChiefTriggerDraftV1[] | null;
export interface CrewChiefTriggerInputV1 { frame: CrewChiefTriggerFrame; context: CrewChiefTriggerContextV1; sessionTimeMs: number; }
export type CrewChiefTriggerFunction<S> = (input: CrewChiefTriggerInputV1, state: S) => CrewChiefTriggerResultV1;
export const crewChiefSource = (family: CrewChiefEventFamily): CrewChiefSourceRef => ({ ...(CREWCHIEF_REFERENCE), path: `CrewChiefV4/Events/${family}.cs`, symbols: [family === "Spotter" || family === "SessionEndMessages" ? "trigger" : "triggerInternal"] });
