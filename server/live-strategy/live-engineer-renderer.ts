import type { OpponentPaceRenderParametersV1, OpponentPaceTextKeyV1, LiveEngineerVoiceModeV1 } from "../../shared/racing/live/engineer-contracts";
import fullLineCatalog from "../../shared/racing/live/full-lines.json";
import type { CrewChiefTriggerEventV1 } from "./crewchief-triggers/contracts";
import type { SpotterStateV1 } from "../../shared/racing/live/spotter-contracts";
import { formatLiveEngineerDeltaText, liveEngineerIntegerAtoms, liveEngineerNumberAtoms } from "../../shared/racing/live/time-text";

export interface LiveEngineerRenderedSpeech {
  textKey: string;
  text: string;
  segmentIds: readonly string[];
  voiceMode: LiveEngineerVoiceModeV1;
}

const textKeyFor = (relation: OpponentPaceRenderParametersV1["relation"]): OpponentPaceTextKeyV1 => ({
  "fastest-in-class": "live_engineer_opponent_fastest",
  "setting-race-pace": "live_engineer_opponent_setting_race_pace",
  "within-class-pace": "live_engineer_opponent_within_pace",
  "off-class-pace": "live_engineer_opponent_off_pace",
  "outlier-lap": "live_engineer_opponent_outlier",
}[relation] as OpponentPaceTextKeyV1);

const scopeText = (scope: OpponentPaceRenderParametersV1["scope"]): string => scope === "class" ? "class" : "overall";
const formatMs = (ms: number, decimals: number): string => (ms / 1000).toFixed(decimals);
const scopeTitle = (scope: OpponentPaceRenderParametersV1["scope"]): string => scope === "class" ? "Class" : "Overall";

export function renderOpponentPaceText(parameters: OpponentPaceRenderParametersV1, voiceMode: LiveEngineerVoiceModeV1 = "automatic"): string {
  const scope = scopeText(parameters.scope);
  const delta = formatLiveEngineerDeltaText(parameters.deltaMs, voiceMode === "automatic" ? 1 : 3);
  switch (parameters.relation) {
    case "fastest-in-class": return parameters.scope === "class" ? "Fastest in class." : "Fastest overall.";
    case "setting-race-pace": return "You are setting the current race pace.";
    case "within-class-pace": return `You are ${delta} from ${scope} pace.`;
    case "off-class-pace": return `You are ${delta} off ${scope} pace.`;
    case "outlier-lap": return `That lap is ${delta} off ${scope} pace.`;
  }
}

export const numberAtoms = liveEngineerNumberAtoms;

export function numberSegmentIds(value: number, decimals = 1): string[] {
  return numberAtoms(value, decimals).map((atom) => `number.${atom}`);
}
export function lapTimeAtoms(ms: number): string[] {
  if (!Number.isInteger(ms) || ms <= 0 || ms > 999 * 60_000 + 59_999) return [];
  const minutes = Math.floor(ms / 60_000);
  const remainder = ms % 60_000;
  const seconds = Math.floor(remainder / 1000);
  const millis = remainder % 1000;
  const result: string[] = [];
  if (minutes) result.push(...liveEngineerIntegerAtoms(minutes), "minute");
  result.push(...liveEngineerIntegerAtoms(seconds));
  if (millis) result.push("point", ...String(millis).padStart(3, "0").split("").map((digit) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][Number(digit)]!));
  return result;
}
export function renderLapTime(ms: number): LiveEngineerRenderedSpeech {
  const atoms = lapTimeAtoms(ms);
  return {
    textKey: "live_engineer_exact_lap_time",
    text: `Your lap was ${atoms.join(" ")}.`,
    segmentIds: ["phrase.exact.your-lap", ...atoms.map((atom) => atom === "minute" || atom === "minutes" ? `unit.${atom}` : `number.${atom}`)],
    voiceMode: "automatic",
  };
}

export function renderOpponentPace(parameters: OpponentPaceRenderParametersV1, options: { voiceMode?: LiveEngineerVoiceModeV1; catalogVersion?: string } = {}): LiveEngineerRenderedSpeech {
  const voiceMode = options.voiceMode ?? "automatic";
  if (parameters.relation === "fastest-in-class" || parameters.relation === "setting-race-pace") {
    const segmentIds = parameters.relation === "fastest-in-class"
      ? [`phrase.fastest.${parameters.scope}`]
      : ["phrase.setting-race-pace"];
    return { textKey: textKeyFor(parameters.relation), text: renderOpponentPaceText(parameters, voiceMode), segmentIds, voiceMode };
  }
  const deltaSegments = numberSegmentIds(Math.abs(parameters.deltaMs) / 1000, voiceMode === "automatic" ? 1 : 3);
  const join = parameters.relation === "within-class-pace" ? "from" : "off";
  const deltaSeconds = Math.abs(parameters.deltaMs) / 1000;
  const unit = deltaSeconds === 1 ? "unit.second" : "unit.seconds";
  const segmentIds = [`phrase.${parameters.relation}`, ...deltaSegments, unit, `phrase.${join}`, `phrase.scope.${parameters.scope}`];
  return { textKey: textKeyFor(parameters.relation), text: renderOpponentPaceText(parameters, voiceMode), segmentIds, voiceMode };
}
export function renderOpponentLapPace(parameters: OpponentPaceRenderParametersV1, options: { voiceMode?: LiveEngineerVoiceModeV1 } = {}): LiveEngineerRenderedSpeech {
  const voiceMode = options.voiceMode ?? "automatic";
  const deltaMs = Math.abs(parameters.deltaMs);
  if (deltaMs === 0) return { textKey: "live_engineer_opponent_lap_pace", text: "Same pace as opponent last lap.", segmentIds: ["phrase.same-pace-last-lap"], voiceMode };
  const deltaSegments = numberSegmentIds(deltaMs / 1000, voiceMode === "automatic" ? 1 : 3);
  const prefix = parameters.deltaMs > 0 ? "phrase.opponent-was" : "phrase.you-were";
  const unit = deltaMs === 1000 ? "unit.second" : "unit.seconds";
  return {
    textKey: "live_engineer_opponent_lap_pace",
    text: `${parameters.deltaMs > 0 ? "Opponent was" : "You were"} ${formatLiveEngineerDeltaText(deltaMs, voiceMode === "automatic" ? 1 : 3)} faster last lap.`,
    segmentIds: [prefix, ...deltaSegments, unit, "phrase.faster-last-lap"],
    voiceMode,
  };
}
export type LiveEngineerPreviewLine = "tires-cold" | "tires-optimal" | "pit-this-lap" | "pit-pit-pit";
const PREVIEW_LINE_IDS: readonly LiveEngineerPreviewLine[] = ["tires-cold", "tires-optimal", "pit-this-lap", "pit-pit-pit"];
const PREVIEW_LINES = Object.fromEntries(PREVIEW_LINE_IDS.map((lineId) => [lineId, fullLineCatalog.find((entry) => entry.lineId === lineId)?.spokenText ?? ""])) as Record<LiveEngineerPreviewLine, string>;
export function renderPreviewLine(lineId: LiveEngineerPreviewLine): { lineId: LiveEngineerPreviewLine; text: string } {
  return { lineId, text: PREVIEW_LINES[lineId] };
}

export function renderSpotter(state: SpotterStateV1): LiveEngineerRenderedSpeech {
  const text = {
    clear: "Clear.",
    "car-left": "Car left.",
    "car-right": "Car right.",
    "still-there": "Still there.",
    "three-wide-left": "Three wide, left.",
    "three-wide-right": "Three wide, right.",
    "clear-left": "Clear left.",
    "clear-right": "Clear right.",
  }[state];
  return { textKey: `live_engineer_spotter_${state.replaceAll("-", "_")}`, text, segmentIds: state === "clear" ? [] : [`spotter.${state}`], voiceMode: "automatic" };
}

export function formatLapTime(ms: number): string { return formatMs(ms, 3); }
const CREW_CHIEF_EVENT_TEXT: Readonly<Record<string, string>> = {
  "position-changed": "Position changed.",
  "pre-lights": "Get ready for the start.",
  "green-flag": "Green flag.",
  "lap-completed": "Lap completed.",
  "opponent-lap-completed": "Opponent lap completed.",
  "multiclass-traffic": "Multiclass traffic ahead.",
  "penalty-issued": "Penalty issued.",
  "pit-entry": "Pit entry.",
  "pit-exit": "Pit exit.",
  "fuel-low": "Fuel is low.",
  "fuel-critical": "Fuel is critical.",
  "flag-change": "Flag changed.",
  "tyres-cold": "Tires are cold.",
  "tyres-hot": "Tires are hot.",
  "tyres-cooking": "Tires are overheating.",
  "water-temperature-hot": "Water temperature is high.",
  "water-temperature-clear": "Water temperature is clear.",
  "damage-reported": "Damage reported.",
  "rain-changed": "Rain conditions changed.",
};

export function renderCrewChiefEvent(
  event: CrewChiefTriggerEventV1,
  options: { voiceMode?: LiveEngineerVoiceModeV1 } = {},
): LiveEngineerRenderedSpeech | null {
  const baseText = CREW_CHIEF_EVENT_TEXT[event.eventKey];
  if (!baseText) return null;
  const flag = event.eventKey === "flag-change" ? String(event.payload.current ?? "").toLowerCase() : "";
  const damageEntries = event.eventKey === "damage-reported"
    ? (["front", "rear", "left", "right", "centre"] as const).map((location) => [location, Number(event.payload[location])] as const).filter((entry) => Number.isFinite(entry[1]))
    : [];
  const damage = damageEntries.sort((a, b) => b[1] - a[1])[0];
  const damageLocation = damage?.[0];
  const damageHeavy = damage !== undefined && damage[1] >= 0.3;
  const text = flag === "black" ? "Black flag. Black flag." : flag === "blue" ? "Blue flag." : flag === "green" ? "Green flag." : damageLocation ? `${damageHeavy ? "Heavy damage" : "You've got damage"} ${damageLocation === "front" ? "at the front." : damageLocation === "rear" ? "at the rear." : damageLocation === "left" ? "on the left." : damageLocation === "right" ? "on the right." : "in the centre."}` : baseText;
  const voiceMode = options.voiceMode ?? "automatic";
  const segmentId = flag === "black" ? "race-engineer.black-flag" : flag === "blue" ? "race-engineer.blue-flag" : flag === "green" ? "race-engineer.green-flag" : damageLocation ? `race-engineer.damage-${damageHeavy ? "heavy-" : ""}${damageLocation}` : `race-engineer.${event.eventKey}`;
  const segmentIds = [segmentId];
  const lapTimeMs = event.eventKey === "lap-completed"
    ? typeof event.payload.lapTimeMs === "number" && Number.isFinite(event.payload.lapTimeMs)
      ? event.payload.lapTimeMs
      : typeof event.payload.time === "number" && Number.isFinite(event.payload.time) ? Math.round(event.payload.time * 1000) : undefined
    : undefined;
  if (lapTimeMs !== undefined && lapTimeAtoms(lapTimeMs).length > 0) {
    const lap = renderLapTime(lapTimeMs);
    return { textKey: `live_engineer_${event.eventKey}`, text: `${text} ${lap.text}`, segmentIds: [...segmentIds, ...lap.segmentIds], voiceMode };
  }
  return { textKey: `live_engineer_${event.eventKey}`, text, segmentIds, voiceMode };
}
export { scopeTitle };
