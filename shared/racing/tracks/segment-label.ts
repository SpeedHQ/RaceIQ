/**
 * Display labels for track segments, shared by the detail map (drawTrack), the
 * segment list/editor, and the AI track-guide context so they can't drift apart.
 *
 * Every turn is its own segment carrying its official `number` (plus `covers`
 * for numbers the detector can't split, e.g. Pouhon = 10 covering 11), and the
 * number leads the label: "T" (the turn type marker) + the numbering + the
 * name, so "T10-11 Pouhon". Unnamed corners already arrive as a "T<number>"
 * token from alignSegments, which would read "T6 T6" — those render as bare
 * "T6" / "T6-7". Straights have no official numbering and are numbered
 * sequentially.
 *
 * Segments sharing a `group` are one named piece of track (a complex, or the
 * start/finish straight split by the line): `segmentDisplayNames` labels each
 * entry on its own (lists and the editor need per-turn rows), while
 * `segmentGroupLabels` labels the piece once (the map draws it once).
 */

type LabelSegment = {
  type: string;
  name: string;
  number?: number;
  covers?: number[];
  group?: string;
};

export interface LapWrappedSegmentGroup {
  group: string;
  firstIndex: number;
  lastIndex: number;
}

/**
 * Identify one logical section split by lap-fraction boundary. Internal
 * geometry keeps both 0-side and 1-side ranges; presentation can count and
 * render them as one section.
 */
export function lapWrappedSegmentGroup(segments: readonly Pick<LabelSegment, "type" | "group">[]): LapWrappedSegmentGroup | null {
  if (segments.length < 2) return null;
  const first = segments[0];
  const lastIndex = segments.length - 1;
  const last = segments[lastIndex];
  if (!first.group || first.group !== last.group || first.type !== last.type) {
    return null;
  }
  return {
    group: first.group,
    firstIndex: 0,
    lastIndex,
  };
}

/** Count driver-facing sections, collapsing a section split at the lap boundary. */
export function logicalSegmentCounts(segments: readonly Pick<LabelSegment, "type" | "group">[]): { corners: number; straights: number } {
  let corners = 0;
  let straights = 0;
  for (const segment of segments) {
    if (segment.type === "corner") corners++;
    if (segment.type === "straight") straights++;
  }
  const lapWrap = lapWrappedSegmentGroup(segments);
  if (lapWrap) {
    if (segments[lapWrap.firstIndex].type === "corner") corners--;
    if (segments[lapWrap.firstIndex].type === "straight") straights--;
  }
  return { corners, straights };
}
/** Official turn numbers a corner entry accounts for, lowest first. */
export function turnNumbers(seg: Pick<LabelSegment, "number" | "covers">): number[] {
  return seg.number === undefined ? [] : [seg.number, ...(seg.covers ?? [])];
}

/** "2-4" for a contiguous run, "1" for one, "2,4" when there's a gap. */
export function formatTurnNumbers(numbers: number[]): string {
  const nums = [...numbers].sort((a, b) => a - b);
  if (nums.length === 0) return "";
  if (nums.length === 1) return String(nums[0]);
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  return contiguous ? `${nums[0]}-${nums[nums.length - 1]}` : nums.join(",");
}

export const AUTO_TURN_TOKEN = /^T\d+$/;
const AUTO_STRAIGHT_NAME = /^S[\d?]*$/;
/** A corner with no name yet: blank, or the editor's "T"/"T?" placeholder.
 *  "T6" is NOT one — that token carries an official turn number. */
const UNNAMED_CORNER = /^T\??$/;

/**
 * Corners and straights are numbered on separate sequences: a corner falls back
 * to `T<cornerNum>` only when it has neither an official number nor a name,
 * a straight always renumbers to `S<straightNum>` unless it has a real name.
 */
export function segmentDisplayName(seg: LabelSegment, straightNum: number, cornerNum = 0): string {
  if (seg.type === "straight") {
    return !seg.name || AUTO_STRAIGHT_NAME.test(seg.name) ? `S${straightNum}` : seg.name;
  }
  const numbers = turnNumbers(seg);
  if (numbers.length === 0 && cornerNum > 0 && (!seg.name || UNNAMED_CORNER.test(seg.name))) return `T${cornerNum}`;
  return labelWithNumbers(seg.name, numbers);
}

function labelWithNumbers(name: string, numbers: number[]): string {
  if (numbers.length === 0) return name;
  // "T" is the turn type marker, the range is the official numbering: "T10-11".
  const token = `T${formatTurnNumbers(numbers)}`;
  // An unnamed corner is already just that token — don't repeat it, and don't
  // trail a space where the name would have gone.
  return !name.trim() || AUTO_TURN_TOKEN.test(name) ? token : `${token} ${name}`;
}

/**
 * The label the AI prompt and the expert track guide use for a corner: the
 * name first, the official numbering in parentheses — "Fairmont Hairpin (6)",
 * "Piscine (14-15)". Prose reads by name, and the numbers disambiguate without
 * the map's "T" type marker (nothing in a prompt needs telling a corner is a
 * corner). Unnamed corners have only the marker to fall back on: bare "T6".
 */
export function cornerPromptLabel(name: string, numbers: number[]): string {
  if (numbers.length === 0) return name;
  const range = formatTurnNumbers(numbers);
  return !name.trim() || AUTO_TURN_TOKEN.test(name) ? `T${range}` : `${name} (${range})`;
}

/**
 * Every labelling of a lap is one of two styles crossed with one of two
 * granularities, so they all run through here — four exported wrappers, one
 * numbering pass. Splitting them into separate implementations is what let the
 * map and the prompt drift apart in the first place.
 *
 * Style: "map" leads with the type marker ("T2-4 Eau Rouge/Raidillon") because
 * a label on a track drawing has no sentence around it to say what it is;
 * "prompt" reads as prose with the numbering in parentheses ("Eau
 * Rouge/Raidillon (2-4)").
 *
 * Granularity: per *entry* gives every segment a label (lists, editor rows and
 * per-segment tables need a row each), per *piece* collapses a group onto its
 * first member carrying the whole group's numbering and gives the rest "" —
 * the map draws that piece once, and the prompt names it once.
 */
type LabelStyle = "map" | "prompt";

function entryLabel(seg: LabelSegment, style: LabelStyle, straightNum: number, cornerNum: number): string {
  // Straights carry no numbering, so both styles render them identically.
  if (style === "map" || seg.type === "straight") return segmentDisplayName(seg, straightNum, cornerNum);
  const numbers = turnNumbers(seg);
  if (numbers.length === 0 && cornerNum > 0 && (!seg.name || UNNAMED_CORNER.test(seg.name))) return `T${cornerNum}`;
  return cornerPromptLabel(seg.name, numbers);
}

function labelSegments(segments: LabelSegment[], style: LabelStyle, collapseGroups: boolean): string[] {
  let sNum = 1;
  let tNum = 1;
  return segments.map((s) => {
    // Corners and straights count on their own sequences, and a collapsed
    // member still consumes its number so the positional fallbacks don't shift.
    const straightNum = s.type === "straight" ? sNum++ : 0;
    const cornerNum = s.type === "straight" ? 0 : tNum++;
    if (!collapseGroups || !s.group) return entryLabel(s, style, straightNum, cornerNum);
    const members = segments.filter((o) => o.group === s.group);
    if (members[0] !== s) return "";
    // A collapsed piece is named by its group in both styles — the group *is*
    // the whole piece's name, and the member names are per-half ("Mirabeau
    // Bas" for the group "Portier"). Reading `name` here for one style and
    // `group` for the other is how the map and the prompt drift apart on a
    // group whose first member is unnamed (Spa's Eau Rouge/Raidillon).
    if (s.type === "straight") return s.group || s.name || entryLabel(s, style, straightNum, cornerNum);
    const numbers = members.flatMap(turnNumbers);
    return style === "map" ? labelWithNumbers(s.group, numbers) : cornerPromptLabel(s.group || s.name, numbers);
  });
}

/** Map labels for a whole lap's segments; straights and corners count separately. */
export function segmentDisplayNames(segments: LabelSegment[]): string[] {
  return labelSegments(segments, "map", false);
}

/**
 * Map labels for consumers that draw each piece of track once: grouped entries
 * collapse into a single label on the first member — "T7-8 Rivazza" for two
 * apexes, one "Wheatcroft Straight" for the two halves the start/finish line
 * cuts — and the other members get "" (draw nothing).
 */
export function segmentGroupLabels(segments: LabelSegment[]): string[] {
  return labelSegments(segments, "map", true);
}

/**
 * Prompt/guide labels, one entry per *piece* of track: a group collapses onto
 * its first member carrying the whole group's numbering ("Eau Rouge/Raidillon
 * (2-4)"). The prompt lists each named piece once, and a guide entry spanning
 * the group must resolve to that one label or it reads as several corners.
 */
export function segmentPromptLabels(segments: LabelSegment[]): string[] {
  return labelSegments(segments, "prompt", true);
}

/**
 * Prompt labels with a row per segment, for tables that carry per-segment
 * numbers (the inputs comparison times every segment separately, including
 * each apex of a group). Same spelling as `segmentPromptLabels`, so a name in
 * one prompt is a name the other — and the analyst whitelist — recognises.
 */
export function segmentPromptNames(segments: LabelSegment[]): string[] {
  return labelSegments(segments, "prompt", false);
}
