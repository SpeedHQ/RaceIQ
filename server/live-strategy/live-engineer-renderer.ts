import type { OpponentPaceRenderParametersV1, OpponentPaceTextKeyV1, LiveEngineerVoiceModeV1 } from "../../shared/racing/live/engineer-contracts";
import fullLineCatalog from "../../shared/racing/live/full-lines.json";
import type { CrewChiefTriggerEventV1 } from "./crewchief-triggers/contracts";
import type { SpotterStateV1 } from "../../shared/racing/live/spotter-contracts";

export interface LiveEngineerRenderedSpeech {
  textKey: string;
  text: string;
  segmentIds: readonly string[];
  voiceMode: LiveEngineerVoiceModeV1;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"] as const;
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;
const DIGITS = ONES.slice(0, 10);
const textKeyFor = (relation: OpponentPaceRenderParametersV1["relation"]): OpponentPaceTextKeyV1 => ({
  "fastest-in-class": "live_engineer_opponent_fastest",
  "setting-race-pace": "live_engineer_opponent_setting_race_pace",
  "within-class-pace": "live_engineer_opponent_within_pace",
  "off-class-pace": "live_engineer_opponent_off_pace",
  "outlier-lap": "live_engineer_opponent_outlier",
}[relation] as OpponentPaceTextKeyV1);
const scopeWord = (scope: OpponentPaceRenderParametersV1["scope"]): "class" | "overall" => scope === "class" ? "class" : "overall";
const scopeTitle = (scope: OpponentPaceRenderParametersV1["scope"]): string => scope === "class" ? "Class" : "Overall";

function integerWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 999) return "";
  if (value < 20) return ONES[value]!;
  if (value < 100) return value % 10 ? `${TENS[Math.floor(value / 10)]} ${ONES[value % 10]}` : TENS[value / 10]!;
  const remainder = value % 100;
  return `${ONES[Math.floor(value / 100)]} hundred${remainder ? ` ${integerWords(remainder)}` : ""}`;
}
function atomIntegerSegmentIds(value: number): string[] {
  if (value < 20) return [`number.atom.${ONES[value]}`];
  return [`number.atom.${TENS[Math.floor(value / 10)]}`, ...(value % 10 ? [`number.atom.${ONES[value % 10]}`] : [])];
}
function integerSegmentIds(value: number): string[] {
  if (!Number.isInteger(value) || value < 0 || value > 999) return [];
  if (value < 100) return [`number.integer.${value}`];
  const remainder = value % 100;
  return [`number.atom.${ONES[Math.floor(value / 100)]}`, "number.atom.hundred", ...(remainder ? atomIntegerSegmentIds(remainder) : [])];
}
function numberWordsFromTenths(tenths: number): string {
  const integer = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return fraction ? `${integer ? `${integerWords(integer)} ` : ""}point ${DIGITS[fraction]}` : integerWords(integer);
}
function paceNumber(deltaMs: number): { text: string; segmentIds: string[]; singular: boolean } | null {
  if (!Number.isFinite(deltaMs) || deltaMs < 0 || deltaMs > 999_000) return null;
  const tenths = Math.floor((deltaMs + 50) / 100);
  const integer = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  const segmentIds = integer ? integerSegmentIds(integer) : [];
  if (fraction) segmentIds.push(`number.tenth.${fraction}`);
  return { text: numberWordsFromTenths(tenths), segmentIds, singular: tenths === 10 };
}
function paceTail(scope: "class" | "overall", relation: "within-class-pace" | "off-class-pace" | "outlier-lap", singular: boolean): string {
  const relationWord = relation === "within-class-pace" ? "from" : "off";
  return `pace.tail.${singular ? "second" : "seconds"}-${relationWord}-${scope}`;
}

export function renderOpponentPaceText(parameters: OpponentPaceRenderParametersV1, voiceMode: LiveEngineerVoiceModeV1 = "automatic"): string {
  void voiceMode;
  const scope = scopeWord(parameters.scope);
  const number = paceNumber(Math.abs(parameters.deltaMs));
  const delta = number ? `${number.text} ${number.singular ? "second" : "seconds"}` : `${(Math.abs(parameters.deltaMs) / 1000).toFixed(1)} seconds`;
  switch (parameters.relation) {
    case "fastest-in-class": return parameters.scope === "class" ? "Fastest in class." : "Fastest overall.";
    case "setting-race-pace": return "You are setting the current race pace.";
    case "within-class-pace": return `You are ${delta} from ${scope} pace.`;
    case "off-class-pace": return `Your lap was ${delta} off ${scope} pace.`;
    case "outlier-lap": return `Your lap was ${delta} off ${scope} pace.`;
  }
}

export function renderLapTime(ms: number): LiveEngineerRenderedSpeech {
  const voiceMode = "automatic" as const;
  if (!Number.isInteger(ms) || ms < 1 || ms > 59_999_999) return { textKey: "live_engineer_exact_lap_time", text: "", segmentIds: [], voiceMode };
  const spokenMs = Math.max(100, Math.floor((ms + 50) / 100) * 100);
  const totalMinutes = Math.floor(spokenMs / 60_000);
  const remainder = spokenMs % 60_000;
  const seconds = Math.floor(remainder / 1000);
  const tenth = Math.floor((remainder % 1000) / 100);
  const parts: string[] = ["Your lap was"];
  const segmentIds: string[] = ["lap.lead.your-lap-was"];
  if (totalMinutes <= 9) {
    const bodyId = `lap.body.${totalMinutes}-${String(seconds).padStart(2, "0")}`;
    segmentIds.push(bodyId);
    if (totalMinutes === 0) parts.push(integerWords(seconds));
    else if (seconds === 0) parts.push(`${integerWords(totalMinutes)} minute${totalMinutes === 1 ? "" : "s"}`);
    else parts.push(`${integerWords(totalMinutes)} ${seconds < 10 ? `oh ${integerWords(seconds)}` : integerWords(seconds)}`);
  } else {
    if (totalMinutes < 100) segmentIds.push(`lap.minutes.${totalMinutes}`);
    else segmentIds.push(...integerSegmentIds(totalMinutes).map((id) => id.replace("number.integer.", "number.atom.")), "number.atom.minutes");
    parts.push(`${integerWords(totalMinutes)} minutes`);
    if (seconds) { segmentIds.push(`lap.seconds.${String(seconds).padStart(2, "0")}`); parts.push(seconds < 10 ? `oh ${integerWords(seconds)}` : integerWords(seconds)); }
  }
  if (tenth) { segmentIds.push(`lap.tenth.${tenth}`); parts.push(`point ${integerWords(tenth)}`); }
  else { segmentIds.push("lap.tail.flat"); parts.push("flat"); }
  return { textKey: "live_engineer_exact_lap_time", text: `${parts.join(" ")}.`, segmentIds, voiceMode };
}

export function renderOpponentPace(parameters: OpponentPaceRenderParametersV1, options: { voiceMode?: LiveEngineerVoiceModeV1; catalogVersion?: string } = {}): LiveEngineerRenderedSpeech {
  const voiceMode = options.voiceMode ?? "automatic";
  if (parameters.relation === "fastest-in-class" || parameters.relation === "setting-race-pace") {
    const segmentIds = parameters.relation === "fastest-in-class" ? [`phrase.fastest.${parameters.scope}`] : ["phrase.setting-race-pace"];
    return { textKey: textKeyFor(parameters.relation), text: renderOpponentPaceText(parameters, voiceMode), segmentIds, voiceMode };
  }
  const number = paceNumber(Math.abs(parameters.deltaMs));
  if (!number) return { textKey: textKeyFor(parameters.relation), text: renderOpponentPaceText(parameters, voiceMode), segmentIds: [], voiceMode };
  const scope = scopeWord(parameters.scope);
  const lead = parameters.relation === "within-class-pace" ? "pace.lead.you-are" : "lap.lead.your-lap-was";
  return { textKey: textKeyFor(parameters.relation), text: renderOpponentPaceText(parameters, voiceMode), segmentIds: [lead, ...number.segmentIds, paceTail(scope, parameters.relation, number.singular)], voiceMode };
}

export function renderOpponentLapPace(parameters: OpponentPaceRenderParametersV1, options: { voiceMode?: LiveEngineerVoiceModeV1 } = {}): LiveEngineerRenderedSpeech {
  const voiceMode = options.voiceMode ?? "automatic";
  const deltaMs = Math.abs(parameters.deltaMs);
  if (!deltaMs) return { textKey: "live_engineer_opponent_lap_pace", text: "Same pace as opponent last lap.", segmentIds: ["opponent-lap.same-pace"], voiceMode };
  const number = paceNumber(deltaMs);
  const fallback = `${(deltaMs / 1000).toFixed(1)} seconds`;
  const spoken = number ? `${number.text} ${number.singular ? "second" : "seconds"}` : fallback;
  return { textKey: "live_engineer_opponent_lap_pace", text: `${parameters.deltaMs > 0 ? "Opponent was" : "You were"} ${spoken} faster last lap.`, segmentIds: number ? [`opponent-lap.lead.${parameters.deltaMs > 0 ? "opponent-was" : "you-were"}`, ...number.segmentIds, `opponent-lap.tail.${number.singular ? "second" : "seconds"}-faster-last-lap`] : [], voiceMode };
}

export type LiveEngineerPreviewLine = "tires-cold" | "tires-optimal" | "pit-this-lap" | "pit-pit-pit";
const PREVIEW_LINE_IDS: readonly LiveEngineerPreviewLine[] = ["tires-cold", "tires-optimal", "pit-this-lap", "pit-pit-pit"];
const PREVIEW_LINES = Object.fromEntries(PREVIEW_LINE_IDS.map((lineId) => [lineId, fullLineCatalog.find((entry) => entry.lineId === lineId)?.spokenText ?? ""])) as Record<LiveEngineerPreviewLine, string>;
export function renderPreviewLine(lineId: LiveEngineerPreviewLine): { lineId: LiveEngineerPreviewLine; text: string } { return { lineId, text: PREVIEW_LINES[lineId] }; }

export function renderSpotter(state: SpotterStateV1): LiveEngineerRenderedSpeech {
  const text = { clear: "Clear.", "car-left": "Car left.", "car-right": "Car right.", "still-there": "Still there.", "three-wide-left": "Three wide, left.", "three-wide-right": "Three wide, right.", "clear-left": "Clear left.", "clear-right": "Clear right." }[state];
  return { textKey: `live_engineer_spotter_${state.replaceAll("-", "_")}`, text, segmentIds: state === "clear" ? [] : [`spotter.${state}`], voiceMode: "automatic" };
}

export function formatLapTime(ms: number): string { return `${(ms / 1000).toFixed(3)}`; }
const CREW_CHIEF_EVENT_TEXT: Readonly<Record<string, string>> = {
  "position-changed": "Position changed.", "pre-lights": "Get ready for the start.", "green-flag": "Green flag.", "final-lap": "Final lap.",
  "lap-completed": "Lap completed.", "lap-invalidated": "Lap invalidated.", "opponent-lap-completed": "Opponent lap completed.",
  "multiclass-traffic": "Multiclass traffic ahead.", "penalty-issued": "Penalty issued.", "pit-entry": "Pit entry.", "pit-exit": "Pit exit.",
  "fuel-low": "Fuel is low.", "fuel-critical": "Fuel is critical.", "flag-change": "Flag changed.",
  "tyres-cold": "Tires are cold.", "tyres-hot": "Tires are hot.", "tyres-cooking": "Tires are overheating.",
  "water-temperature-hot": "Water temperature is high.", "water-temperature-clear": "Water temperature is clear.",
  "damage-reported": "Damage reported.", "rain-changed": "Rain conditions changed.",
  "race-time-15-minutes": "Fifteen minutes remaining.", "race-time-10-minutes": "Ten minutes remaining.",
  "race-time-5-minutes": "Five minutes remaining.", "race-time-2-minutes": "Two minutes remaining.", "race-time-1-minute": "One minute remaining.",
  "session-ended": "Session finished.",
  "gap-ahead-closing": "You're closing the gap to the car ahead.", "gap-ahead-growing": "The car ahead is pulling away.",
  "gap-behind-closing": "The car behind is closing in.", "gap-behind-growing": "You're pulling away from the car behind.",
  "driver-changed": "An opponent has changed drivers.",
  "fuel-save-required": "At this consumption, you'll need more fuel to finish.",
  "fuel-to-finish": "You now have enough fuel to finish at this consumption.",
  "push-now": "Closing laps. Fuel looks good. Push now.", "drs-open": "DRS is open.", "drs-closed": "DRS is closed.",
};
export function renderCrewChiefEvent(event: CrewChiefTriggerEventV1, options: { voiceMode?: LiveEngineerVoiceModeV1 } = {}): LiveEngineerRenderedSpeech | null {
  // Entry notification arrives after driver already committed to pit lane; it adds no actionable information.
  if (event.eventKey === "pit-entry") return null;
  const minutes = event.payload.minutesRemaining;
  const speechKey = event.eventKey === "race-time-remaining"
    ? typeof minutes === "number" && [15, 10, 5, 2, 1].includes(minutes)
      ? `race-time-${minutes}-${minutes === 1 ? "minute" : "minutes"}` : ""
    : event.eventKey;
  const baseText = CREW_CHIEF_EVENT_TEXT[speechKey];
  if (!baseText) return null;
  const flag = event.eventKey === "flag-change" ? String(event.payload.current ?? "").toLowerCase() : "";
  const damageEntries = event.eventKey === "damage-reported" ? (["front", "rear", "left", "right", "centre"] as const).map((location) => [location, Number(event.payload[location])] as const).filter((entry) => Number.isFinite(entry[1])) : [];
  const damage = damageEntries.sort((a, b) => b[1] - a[1])[0];
  const damageLocation = damage?.[0];
  const damageHeavy = damage !== undefined && damage[1] >= 0.3;
  const text = flag === "black" ? "Black flag. Black flag." : flag === "blue" ? "Blue flag." : flag === "green" ? "Green flag." : damageLocation ? `${damageHeavy ? "Heavy damage" : "You've got damage"} ${damageLocation === "front" ? "at the front." : damageLocation === "rear" ? "at the rear." : damageLocation === "left" ? "on the left." : damageLocation === "right" ? "on the right." : "in the centre."}` : baseText;
  const voiceMode = options.voiceMode ?? "automatic";
  const segmentId = flag === "black" ? "race-engineer.black-flag" : flag === "blue" ? "race-engineer.blue-flag" : flag === "green" ? "race-engineer.green-flag" : damageLocation ? `race-engineer.damage-${damageHeavy ? "heavy-" : ""}${damageLocation}` : `race-engineer.${speechKey}`;
  const lapTimeMs = event.eventKey === "lap-completed" ? typeof event.payload.lapTimeMs === "number" && Number.isFinite(event.payload.lapTimeMs) ? event.payload.lapTimeMs : typeof event.payload.time === "number" && Number.isFinite(event.payload.time) ? Math.round(event.payload.time * 1000) : undefined : undefined;
  if (lapTimeMs !== undefined) {
    const lap = renderLapTime(lapTimeMs);
    if (lap.segmentIds.length) return { textKey: `live_engineer_${event.eventKey}`, text: lap.text, segmentIds: lap.segmentIds, voiceMode };
  }
  return { textKey: `live_engineer_${event.eventKey}`, text, segmentIds: [segmentId], voiceMode };
}
export { scopeTitle };
