import type { CornerAction, SpectateController, SpectateLap, SpectateSegment, TurnIdentity } from "../contracts";
import { normalizeTurnToken, resolveCornerKey, resolveTurnReference } from "../contracts";
import { cornerPromptLabel } from "@raceiq/shared/racing/tracks/segment-label";

/**
 * Distance-based corner focus for the replay controller (SpeedHQ/RaceIQ#515).
 *
 * Reuses the same fraction → distance conversion as the track overview so the
 * AI path never introduces a second navigation system or frame indices.
 */

export type DistanceRange = { start: number; end: number };

export type DistanceScale = {
  /** Authoritative lap length in metres. */
  maximum: number;
  /** Distance origin when the recording does not start at zero. */
  distanceOrigin: number;
};

export function segmentToDistanceRange(
  segment: Pick<SpectateSegment, "startFrac" | "endFrac">,
  scale: DistanceScale,
): DistanceRange | null {
  if (!(scale.maximum > 0)) return null;
  const rawStart = segment.startFrac * scale.maximum - scale.distanceOrigin;
  const rawEnd = segment.endFrac * scale.maximum - scale.distanceOrigin;
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
  const start = Math.max(0, Math.min(rawStart, rawEnd));
  const end = Math.min(scale.maximum, Math.max(rawStart, rawEnd));
  if (end <= start) return null;
  return { start, end };
}

export type CornerFocusCoverage = {
  a: { distance: number; hasProgress: boolean };
  b: { distance: number; hasProgress: boolean } | null;
};

export type CornerFocusScaleSet = {
  a: DistanceScale;
  b: DistanceScale | null;
  /** Loaded progress; when supplied, ranges beyond it are refused. */
  coverage?: CornerFocusCoverage;
};

function rangeReachable(
  range: DistanceRange,
  coverage: { distance: number; hasProgress: boolean } | null | undefined,
): boolean {
  if (coverage === undefined) return true;
  if (coverage === null) return false;
  return coverage.hasProgress && Number.isFinite(coverage.distance) && range.end <= coverage.distance + 1e-6;
}

/**
 * Authoritative length and recording origin for one loaded lap. Mirrors the
 * track overview conversion so AI focus and the overview markers agree.
 */
export function distanceScaleForLap(
  lap: Pick<SpectateLap, "trackLengthM" | "samples" | "distance">,
  fallbackMaximum?: number,
): DistanceScale {
  const maximum = lap.trackLengthM ?? fallbackMaximum ?? lap.distance;
  let distanceOrigin = 0;
  if (lap.trackLengthM) {
    const sample = lap.samples.find((item) => {
      const traveled = item.values["timing.distance-traveled"];
      return Number.isFinite(item.distance) && typeof traveled === "number" && Number.isFinite(traveled);
    });
    const traveled = sample?.values["timing.distance-traveled"];
    if (sample && typeof traveled === "number") distanceOrigin = traveled - sample.distance;
  }
  return { maximum, distanceOrigin };
}

function segmentTurnNumbers(segment: SpectateSegment): number[] {
  const explicit = [segment.number, ...(segment.covers ?? [])].filter(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0,
  );
  if (explicit.length > 0) return [...new Set(explicit)].sort((a, b) => a - b);
  const match = /^T(\d+)(?:\s*[-–/]\s*(\d+))?/i.exec(segment.name?.trim() ?? "");
  if (!match) return [];
  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : first;
  if (!Number.isInteger(first) || !Number.isInteger(second)) return [];
  return [Math.min(first, second), Math.max(first, second)];
}

function isPlaceholderTurnName(name: string | undefined): boolean {
  const value = name?.trim() ?? "";
  return value.length === 0 || /^T\d+(?:\s*[-–/]\s*\d+)*$/i.test(value);
}

/**
 * Turn identities derived from the loaded segment roster. Keys follow the
 * canonical `t<n>` / `t<n-m>` shape; covered numbers get their own identity so
 * a model naming `T13` inside a 12-13 corner still resolves exactly.
 */
export function cornerTurnsFromSegments(segments: readonly SpectateSegment[]): TurnIdentity[] {
  const turns: TurnIdentity[] = [];
  for (const segment of segments) {
    if (segment.type !== "corner") continue;
    const numbers = segmentTurnNumbers(segment);
    if (numbers.length === 0) continue;
    const display = segment.name?.trim();
    const name = display && !isPlaceholderTurnName(display) ? display : undefined;
    const promptLabel = cornerPromptLabel(name ?? "", numbers);
    const aliases = [display, ...numbers.map((number) => `turn ${number}`)]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const add = (key: string, number: number, extraAliases: readonly string[] = []) => {
      const allAliases = [...new Set([...aliases, ...extraAliases].filter((value) => value.length > 0))];
      turns.push({
        key,
        number,
        ...(name ? { name } : {}),
        ...(allAliases.length > 0 ? { aliases: allAliases } : {}),
      });
    };
    add(`t${numbers.join("-")}`, numbers[0]!, [promptLabel]);
    if (numbers.length > 1) for (const number of numbers) add(`t${number}`, number);
  }
  return turns;
}

export type CornerFocusHandle = {
  stop: () => void;
  /** Entry distance actually used. */
  entry: number;
  /** Exit distance actually used. */
  exit: number;
};

export type CornerFocusExit = { side: "a" | "b"; distance: number };

export type CornerFocusOptions = {
  ranges: readonly DistanceRange[];
  loop: boolean;
  /** Called once when playback paused at the exit (not called for loops). */
  onExit?: () => void;
  /** Side whose distance controls the primary exit. Defaults to A. */
  primary?: "a" | "b";
  /** Primary exit distance. Defaults to the latest range exit. */
  primaryExit?: number;
  /** Additional sides that must each pass their own exit first (linked A/B). */
  exits?: readonly CornerFocusExit[];
};

export type CornerFocusResolution = {
  ranges: DistanceRange[];
  /** Ranges grouped by the lap they were resolved against. */
  rangesBySide: { a: DistanceRange[]; b: DistanceRange[] };
  primary: "a" | "b";
  primaryExit: number;
  exits?: readonly CornerFocusExit[];
};

/**
 * Resolve one validated action against the loaded session. Solo/A use the A
 * lap, B uses the B lap, and linked requires both laps' corresponding ranges.
 * P4 decision (Issue #515): linked playback pauses only after A and B each
 * pass their own exit, so a slower lap is never truncated.
 */
export function resolveSessionCornerFocus(
  action: Pick<CornerAction, "cornerKey" | "target">,
  turns: readonly TurnIdentity[],
  segments: readonly SpectateSegment[],
  scale: CornerFocusScaleSet,
): CornerFocusResolution | null {
  const resolve = (distanceScale: DistanceScale, coverage: { distance: number; hasProgress: boolean } | null | undefined) => {
    const ranges = resolveCornerActionRanges({ action, turns, segments, scale: distanceScale, loop: false });
    if (!ranges) return null;
    const usable = ranges.filter((range) => rangeReachable(range, coverage));
    return usable.length > 0 ? usable : null;
  };
  const aCoverage = scale.coverage?.a;
  const bCoverage = scale.coverage ? scale.coverage.b : undefined;
  if (action.target === "solo" || action.target === "A") {
    const ranges = resolve(scale.a, aCoverage);
    return ranges
      ? { ranges, rangesBySide: { a: ranges, b: [] }, primary: "a", primaryExit: Math.max(...ranges.map((range) => range.end)) }
      : null;
  }
  if (action.target === "B") {
    if (!scale.b) return null;
    const ranges = resolve(scale.b, bCoverage);
    return ranges
      ? { ranges, rangesBySide: { a: [], b: ranges }, primary: "b", primaryExit: Math.max(...ranges.map((range) => range.end)) }
      : null;
  }
  if (action.target === "linked") {
    if (!scale.b) return null;
    const aRanges = resolve(scale.a, aCoverage);
    const bRanges = resolve(scale.b, bCoverage);
    if (!aRanges || !bRanges) return null;
    return {
      ranges: [...aRanges, ...bRanges],
      rangesBySide: { a: aRanges, b: bRanges },
      primary: "a",
      primaryExit: Math.max(...aRanges.map((range) => range.end)),
      exits: [{ side: "b", distance: Math.max(...bRanges.map((range) => range.end)) }],
    };
  }
  return null;
}

/**
 * Play from the entry of the earliest range until the primary exit and every
 * additional exit gate (linked A/B waits for both sides). Loops back to the
 * entry when `loop` is set; otherwise pauses once all gates are passed.
 */
export function startCornerFocus(
  controller: SpectateController,
  options: CornerFocusOptions,
): CornerFocusHandle | null {
  const ranges = options.ranges.filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
  if (ranges.length === 0) return null;

  const entry = Math.min(...ranges.map((range) => range.start));
  const exit = Math.max(...ranges.map((range) => range.end));

  let stopped = false;
  let unsubscribe: (() => void) | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    unsubscribe = null;
  };

  const tick = () => {
    if (stopped) return;
    const snapshot = controller.getSnapshot();
    if (snapshot.seeking) return;
    const primary = options.primary ?? "a";
    const primaryExit = options.primaryExit ?? exit;
    const primaryDistance = snapshot[primary]?.distance;
    if (primaryDistance == null || primaryDistance < primaryExit) return;
    for (const gate of options.exits ?? []) {
      const gateDistance = snapshot[gate.side]?.distance;
      if (gateDistance == null || gateDistance < gate.distance) return;
    }
    if (options.loop) {
      controller.seekDistance(entry, true);
      return;
    }
    // Unsubscribe before pausing: the real controller publishes synchronously,
    // and a still-subscribed tick would re-enter pause until the stack overflows.
    stop();
    controller.pause();
    options.onExit?.();
  };

  controller.seekDistance(entry, true);
  controller.play();
  unsubscribe = controller.subscribe(tick);

  return { stop, entry, exit };
}

export type CornerActionFocusRequest = {
  action: { cornerKey: string };
  turns: readonly TurnIdentity[];
  segments: readonly SpectateSegment[];
  scale: DistanceScale;
  loop: boolean;
};

/**
 * Resolve a validated corner action into distance ranges through the shared
 * turn identity. Unknown corners or missing geometry yield null; nothing seeks.
 */
function segmentMatchesTurn(segment: SpectateSegment, turn: TurnIdentity): boolean {
  if (typeof segment.number === "number" && segment.number === turn.number) return true;
  if (segment.covers?.includes(turn.number)) return true;
  const name = normalizeTurnToken(segment.name ?? "");
  if (!name) return false;
  const candidates = [turn.key, `t${turn.number}`, `turn ${turn.number}`, turn.name, ...(turn.aliases ?? [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(normalizeTurnToken);
  return candidates.includes(name);
}

export function resolveCornerActionRanges(request: CornerActionFocusRequest): DistanceRange[] | null {
  const turn = resolveCornerKey(request.action.cornerKey, request.turns)
    ?? resolveTurnReference(request.action.cornerKey, request.turns);
  if (!turn) return null;
  const ranges: DistanceRange[] = [];
  for (const segment of request.segments) {
    if (!segmentMatchesTurn(segment, turn)) continue;
    const range = segmentToDistanceRange(segment, request.scale);
    if (range) ranges.push(range);
  }
  return ranges.length > 0 ? ranges : null;
}

/** Resolve, then drive the controller. Returns null when nothing can be focused. */
export function dispatchCornerAction(
  controller: SpectateController,
  request: CornerActionFocusRequest,
): CornerFocusHandle | null {
  const ranges = resolveCornerActionRanges(request);
  if (!ranges) return null;
  return startCornerFocus(controller, { ranges, loop: request.loop });
}

