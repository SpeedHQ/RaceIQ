import type { OpponentPaceRenderParametersV1, OpponentPaceTextKeyV1, LiveEngineerVoiceModeV1 } from "../../shared/racing/live/engineer-contracts";
import type { SpotterStateV1 } from "../../shared/racing/live/spotter-contracts";

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

const formatMs = (ms: number, decimals: number): string => (ms / 1000).toFixed(decimals);
const scopeText = (scope: OpponentPaceRenderParametersV1["scope"]): string => scope === "class" ? "class" : "overall";
const scopeTitle = (scope: OpponentPaceRenderParametersV1["scope"]): string => scope === "class" ? "Class" : "Overall";
const absoluteDeltaText = (ms: number, decimals: number): string => `${formatMs(Math.abs(ms), decimals)} seconds`;

export function renderOpponentPaceText(parameters: OpponentPaceRenderParametersV1, voiceMode: LiveEngineerVoiceModeV1 = "automatic"): string {
  const scope = scopeText(parameters.scope);
  const delta = absoluteDeltaText(parameters.deltaMs, voiceMode === "automatic" ? 1 : 3);
  switch (parameters.relation) {
    case "fastest-in-class": return parameters.scope === "class" ? "Fastest in class." : "Fastest overall.";
    case "setting-race-pace": return "You're setting the current race pace.";
    case "within-class-pace": return `You're ${delta} from ${scope} pace.`;
    case "off-class-pace": return `You're ${delta} off ${scope} pace.`;
    case "outlier-lap": return `That lap is ${delta} off ${scope} pace.`;
  }
}

const integerAtoms = (value: number): string[] => {
  if (!Number.isInteger(value) || value < 0 || value > 999) return [];
  const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (value < 20) return [ones[value]!];
  if (value < 100) return value % 10 ? [tens[Math.floor(value / 10)]!, ones[value % 10]!] : [tens[value / 10]!];
  const remainder = value % 100;
  return [ones[Math.floor(value / 100)]!, "hundred", ...(remainder ? integerAtoms(remainder) : [])];
};

export function numberAtoms(value: number, decimals = 1): string[] {
  if (!Number.isFinite(value) || value < 0 || value > 999) return [];
  const rounded = Number(value.toFixed(decimals));
  const integer = Math.floor(rounded);
  const fraction = Math.round((rounded - integer) * 10 ** decimals);
  const atoms = integerAtoms(integer);
  if (!fraction || decimals === 0) return atoms;
  const digits = String(fraction).padStart(decimals, "0").split("").map((digit) => digit === "0" ? "zero" : ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][Number(digit)]!);
  return [...atoms, "point", ...digits];
}

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
  if (minutes) result.push(...integerAtoms(minutes), "minute");
  result.push(...integerAtoms(seconds));
  if (millis) result.push("point", ...String(millis).padStart(3, "0").split("").map((digit) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][Number(digit)]!));
  return result;
}

export function renderOpponentPace(parameters: OpponentPaceRenderParametersV1, options: { voiceMode?: LiveEngineerVoiceModeV1; catalogVersion?: string } = {}): LiveEngineerRenderedSpeech {
  const voiceMode = options.voiceMode ?? "automatic";
  if (parameters.relation === "fastest-in-class" || parameters.relation === "setting-race-pace") {
    return { textKey: textKeyFor(parameters.relation), text: renderOpponentPaceText(parameters, voiceMode), segmentIds: [`phrase.${parameters.relation}.${parameters.scope}`], voiceMode };
  }
  const deltaSegments = numberSegmentIds(Math.abs(parameters.deltaMs) / 1000, voiceMode === "automatic" ? 1 : 3);
  const join = parameters.relation === "within-class-pace" ? "from" : "off";
  const deltaSeconds = Math.abs(parameters.deltaMs) / 1000;
  const unit = deltaSeconds === 1 ? "unit.second" : "unit.seconds";
  const segmentIds = [`phrase.${parameters.relation}`, ...deltaSegments, unit, `phrase.${join}`, `phrase.scope.${parameters.scope}`];
  return { textKey: textKeyFor(parameters.relation), text: renderOpponentPaceText(parameters, voiceMode), segmentIds, voiceMode };
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
export { scopeTitle };
