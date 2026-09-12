import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";
import type { LiveResolvedSemanticFrame } from "../telemetry/live-projector";

export type LiveEngineerLapStateInput = {
  lapNumber: number;
  lastLapTimeSeconds: number;
  currentLapValid: boolean;
  inPit: boolean;
};

export type LiveEngineerPaceInput = {
  playerCarIndex: number;
  playerCarClassId: string;
  sessionType: string;
  competitorCarIndexes: readonly number[];
  competitorDriverIds: readonly unknown[];
  competitorDriverNames: readonly unknown[];
  competitorClassIds: readonly unknown[];
  competitorClassNames: readonly unknown[];
  competitorLaps: readonly number[];
  competitorPitStatuses: readonly unknown[];
  competitorTrackLocations: readonly unknown[] | null;
  competitorConnected: readonly unknown[] | null;
  competitorLastLapTimes: readonly number[];
  competitorLastLapValidity: readonly unknown[] | null;
};

export type LiveEngineerSemanticInput = {
  frame: LiveResolvedSemanticFrame;
  values: ReadonlyMap<string, ResolvedValue<unknown>>;
  lapState: LiveEngineerLapStateInput | null;
  pace: LiveEngineerPaceInput | null;
};

const ok = (value: ResolvedValue<unknown> | undefined): value is ResolvedValue<unknown> => value?.state === "ok";
const scalar = (values: ReadonlyMap<string, ResolvedValue<unknown>>, id: string): unknown => {
  const value = values.get(id);
  return ok(value) ? value.value : undefined;
};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const array = <T>(values: ReadonlyMap<string, ResolvedValue<unknown>>, id: string): readonly T[] | null => {
  const value = scalar(values, id);
  return Array.isArray(value) ? value as readonly T[] : null;
};
const aligned = (lists: readonly (readonly unknown[] | null)[], max = 64): lists is readonly (readonly unknown[])[] => {
  if (lists.some((list) => !list || list.length > max)) return false;
  const length = lists[0]!.length;
  return lists.every((list) => list!.length === length);
};

export function extractLiveEngineerSemanticInput(frame: LiveResolvedSemanticFrame): LiveEngineerSemanticInput {
  const values = new Map<string, ResolvedValue<unknown>>();
  frame.ids.forEach((id, index) => {
    const value = frame.values[index];
    if (value) values.set(id, value);
  });

  const lapNumber = scalar(values, "timing.lap-number");
  const lastLapTimeSeconds = scalar(values, "timing.last-lap");
  let lapState: LiveEngineerLapStateInput | null = null;
  if (finite(lapNumber) && lapNumber > 0 && finite(lastLapTimeSeconds) && lastLapTimeSeconds > 0) {
    if (frame.simulator === "acc") {
      const currentLapValid = scalar(values, "timing.current-lap-valid");
      const pitStatus = scalar(values, "race.pit-status");
      if (typeof currentLapValid === "boolean" && typeof pitStatus === "string") lapState = { lapNumber, lastLapTimeSeconds, currentLapValid, inPit: pitStatus !== "out" && pitStatus !== "on-track" };
    } else if (frame.simulator === "iracing") {
      const trackSurface = scalar(values, "identity.player-track-surface");
      const onPitRoad = scalar(values, "race.on-pit-road");
      if (finite(trackSurface) && typeof onPitRoad === "boolean") lapState = { lapNumber, lastLapTimeSeconds, currentLapValid: trackSurface === 3, inPit: onPitRoad };
    }
  }

  const playerCarIndex = scalar(values, "identity.player-car-index");
  const playerCarClassId = scalar(values, "identity.player-car-class-id");
  const sessionType = scalar(values, "session.session-type");
  const indexes = array<number>(values, "race.competitor.car-index");
  const driverIds = array<unknown>(values, "race.competitor.driver-id");
  const driverNames = array<unknown>(values, "race.competitor.driver-name");
  const classIds = array<unknown>(values, "race.competitor.car-class-id");
  const classNames = array<unknown>(values, "race.competitor.car-class-name");
  const laps = array<number>(values, "race.competitor.laps-complete");
  const pits = array<unknown>(values, "race.competitor.pit-status");
  const locations = array<unknown>(values, "race.competitor.track-location");
  const connected = array<unknown>(values, "race.competitor.connected");
  const times = array<number>(values, "timing.competitor.last-lap-time");
  const validities = array<unknown>(values, "timing.competitor.last-lap-valid");
  const paceLists = [indexes, driverIds, driverNames, classIds, classNames, laps, pits, times];
  let pace: LiveEngineerPaceInput | null = null;
  if (finite(playerCarIndex) && typeof playerCarClassId === "string" && typeof sessionType === "string" && aligned(paceLists)) {
    const requiredForGame = frame.simulator === "acc" ? [connected, validities] : [locations];
    if (aligned([...paceLists, ...requiredForGame])) pace = { playerCarIndex, playerCarClassId, sessionType, competitorCarIndexes: indexes!, competitorDriverIds: driverIds!, competitorDriverNames: driverNames!, competitorClassIds: classIds!, competitorClassNames: classNames!, competitorLaps: laps!, competitorPitStatuses: pits!, competitorTrackLocations: locations, competitorConnected: connected, competitorLastLapTimes: times!, competitorLastLapValidity: validities };
  }
  return { frame, values, lapState, pace };
}
