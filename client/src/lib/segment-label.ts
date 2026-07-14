import type { TrackSegment } from "@/components/track/types";

/**
 * Display labels for track segments, shared by the detail map (drawTrack) and
 * the segment list/editor so the two can't drift apart.
 *
 * Corners carry the official turn numbers they cover (Eau Rouge/Raidillon is
 * one segment covering turns 2-4), so a named corner renders "Name (2-4)".
 * Unnamed corners already arrive as a "T<number>" token from alignSegments,
 * which would read "T6 (6)" — those render as "T6" / "T6-7" instead.
 * Straights have no official numbering and are numbered sequentially.
 */

/** "2-4" for a contiguous run, "1" for one, "2,4" when there's a gap. */
export function formatTurnNumbers(numbers: number[]): string {
  const nums = [...numbers].sort((a, b) => a - b);
  if (nums.length === 0) return "";
  if (nums.length === 1) return String(nums[0]);
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  return contiguous ? `${nums[0]}-${nums[nums.length - 1]}` : nums.join(",");
}

const AUTO_TURN_TOKEN = /^T\d+$/;
const AUTO_STRAIGHT_NAME = /^S[\d?]*$/;

export function segmentDisplayName(seg: Pick<TrackSegment, "type" | "name" | "numbers">, straightNum: number): string {
  if (seg.type === "straight") {
    return !seg.name || AUTO_STRAIGHT_NAME.test(seg.name) ? `S${straightNum}` : seg.name;
  }
  const numbers = seg.numbers ?? [];
  if (numbers.length === 0) return seg.name;
  const range = formatTurnNumbers(numbers);
  // "T6" already states its number — extend the token rather than repeat it.
  return AUTO_TURN_TOKEN.test(seg.name) ? `T${range}` : `${seg.name} (${range})`;
}

/** Labels for a whole lap's segments, with straights numbered in order. */
export function segmentDisplayNames(segments: Pick<TrackSegment, "type" | "name" | "numbers">[]): string[] {
  let sNum = 1;
  return segments.map((s) => {
    const label = segmentDisplayName(s, sNum);
    if (s.type === "straight") sNum++;
    return label;
  });
}
