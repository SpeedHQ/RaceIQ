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

/** Official turn numbers a corner entry accounts for, lowest first. */
export function turnNumbers(seg: LabelSegment): number[] {
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

export function segmentDisplayName(seg: LabelSegment, straightNum: number): string {
  if (seg.type === "straight") {
    return !seg.name || AUTO_STRAIGHT_NAME.test(seg.name) ? `S${straightNum}` : seg.name;
  }
  return labelWithNumbers(seg.name, turnNumbers(seg));
}

function labelWithNumbers(name: string, numbers: number[]): string {
  if (numbers.length === 0) return name;
  // "T" is the turn type marker, the range is the official numbering: "T10-11".
  const token = `T${formatTurnNumbers(numbers)}`;
  // An unnamed corner is already just that token — don't repeat it.
  return AUTO_TURN_TOKEN.test(name) ? token : `${token} ${name}`;
}

/** Labels for a whole lap's segments, with straights numbered in order. */
export function segmentDisplayNames(segments: LabelSegment[]): string[] {
  let sNum = 1;
  return segments.map((s) => {
    const label = segmentDisplayName(s, sNum);
    if (s.type === "straight") sNum++;
    return label;
  });
}

/**
 * Labels for consumers that draw each piece of track once (the map): grouped
 * entries collapse into a single label on the first member — "T7-8 Rivazza"
 * for two apexes, one "Wheatcroft Straight" for the two halves the
 * start/finish line cuts — and the other members get "" (draw nothing).
 */
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
  return AUTO_TURN_TOKEN.test(name) ? `T${range}` : `${name} (${range})`;
}

/**
 * Prompt/guide labels for a lap, one entry per *piece* of track: a group
 * collapses onto its first member carrying the whole group's numbering
 * ("Eau Rouge/Raidillon (2-4)") and the other members get "" — the prompt
 * lists each named piece once, and a guide entry spanning the group must
 * resolve to that one label or it reads as several separate corners.
 */
export function segmentPromptLabels(segments: LabelSegment[]): string[] {
  let sNum = 1;
  return segments.map((s) => {
    const straightNum = s.type === "straight" ? sNum++ : 0;
    const members = s.group ? segments.filter((o) => o.group === s.group) : [s];
    if (members[0] !== s) return "";
    if (s.type === "straight") return s.group || segmentDisplayName(s, straightNum);
    return cornerPromptLabel(s.group || s.name, members.flatMap(turnNumbers));
  });
}

export function segmentGroupLabels(segments: LabelSegment[]): string[] {
  const perEntry = segmentDisplayNames(segments);
  return segments.map((s, i) => {
    if (!s.group) return perEntry[i];
    const members = segments.filter((o) => o.group === s.group);
    if (members[0] !== s) return "";
    if (s.type === "straight") return s.name || perEntry[i];
    return labelWithNumbers(s.group, members.flatMap(turnNumbers));
  });
}
