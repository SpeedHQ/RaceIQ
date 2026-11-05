import type { CornerAction, SpectateController, SpectateSegment, TurnIdentity } from "../contracts";
import { normalizeTurnToken, resolveCornerKey } from "../contracts";

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

export type CornerFocusHandle = {
  stop: () => void;
  /** Entry distance actually used. */
  entry: number;
  /** Exit distance actually used. */
  exit: number;
};

export type CornerFocusOptions = {
  ranges: readonly DistanceRange[];
  loop: boolean;
  /** Called once when playback paused at the exit (not called for loops). */
  onExit?: () => void;
};

/**
 * Play from the entry of the earliest range until the exit of the latest one.
 * Loops back to the entry when `loop` is set; otherwise pauses at the exit.
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
    const distance = snapshot.a?.distance;
    if (distance == null || snapshot.seeking) return;
    if (distance < exit) return;
    if (options.loop) {
      controller.seekDistance(entry, true);
      return;
    }
    controller.pause();
    stop();
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
  const name = normalizeTurnToken(segment.name ?? "");
  if (!name) return false;
  const candidates = [turn.key, `t${turn.number}`, `turn ${turn.number}`, turn.name, ...(turn.aliases ?? [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(normalizeTurnToken);
  return candidates.includes(name);
}

export function resolveCornerActionRanges(request: CornerActionFocusRequest): DistanceRange[] | null {
  const turn = resolveCornerKey(request.action.cornerKey, request.turns);
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

