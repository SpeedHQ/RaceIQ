import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CornerAction, ReplaySession, SpectateController, SpectateSegment } from "../contracts";
import {
  cornerTurnsFromSegments,
  distanceScaleForLap,
  resolveSessionCornerFocus,
  startCornerFocus,
  type CornerFocusHandle,
  type DistanceRange,
} from "./corner-focus";

export type CornerFocusActive = {
  action: CornerAction;
  ranges: readonly DistanceRange[];
  rangesBySide: { a: readonly DistanceRange[]; b: readonly DistanceRange[] };
  primary: "a" | "b";
};

/**
 * Last requested focus. Whether the map/chart band survives after the exit is
 * P3 and stays outside this controller; Esc pause/clear behaviour is P2.
 */

export type CornerFocusController = {
  focus: (action: CornerAction, options: { loop: boolean }) => boolean;
  clear: () => void;
  /** Last requested focus; retained after the exit (P3). */
  active: CornerFocusActive | null;
  /** True only while the focused range is being followed. */
  running: boolean;
  /** False for the inert controller used outside a replay surface. */
  enabled: boolean;
};

const CornerFocusContext = createContext<CornerFocusController | null>(null);
const noopFocus = () => false;
const noopClear = () => undefined;
const NOOP_CONTROLLER: CornerFocusController = { focus: noopFocus, clear: noopClear, active: null, running: false, enabled: false };

/** Safe outside a replay surface: inline references stay inert, never throw. */
export function useCornerFocusController(): CornerFocusController {
  return useContext(CornerFocusContext) ?? NOOP_CONTROLLER;
}

export function CornerFocusProvider({ value, children }: { value: CornerFocusController; children: ReactNode }) {
  return <CornerFocusContext.Provider value={value}>{children}</CornerFocusContext.Provider>;
}

/**
 * Session-level focus dispatcher. One controller, one distance conversion,
 * one close path for solo, A, B and linked A/B (Issue #515).
 */
export function useCornerFocus(
  pair: ReplaySession | null,
  segments: readonly SpectateSegment[],
  controller: SpectateController | null,
): CornerFocusController {
  const context = useMemo(() => {
    if (!pair) return null;
    const fallbackMaximum = pair.comparison.traces?.distance.at(-1);
    return {
      turns: cornerTurnsFromSegments(segments),
      segments,
      scale: {
        a: distanceScaleForLap(pair.a, fallbackMaximum),
        b: pair.b ? distanceScaleForLap(pair.b, fallbackMaximum) : null,
        coverage: {
          a: { distance: pair.a.distance, hasProgress: pair.a.hasProgress },
          b: pair.b ? { distance: pair.b.distance, hasProgress: pair.b.hasProgress } : null,
        },
      },
    };
  }, [pair, segments]);
  const handleRef = useRef<CornerFocusHandle | null>(null);
  const [active, setActive] = useState<CornerFocusActive | null>(null);
  const [running, setRunning] = useState(false);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
  }, []);

  useEffect(() => () => stop(), [stop]);
  useEffect(() => {
    stop();
    setActive(null);
    setRunning(false);
  }, [context, controller, stop]);

  const focus = useCallback(
    (action: CornerAction, options: { loop: boolean }) => {
      if (!context || !controller) return false;
      const resolution = resolveSessionCornerFocus(action, context.turns, context.segments, context.scale);
      if (!resolution) return false;
      stop();
      const handle = startCornerFocus(controller, {
        ranges: resolution.ranges,
        loop: options.loop,
        primary: resolution.primary,
        primaryExit: resolution.primaryExit,
        exits: resolution.exits,
        onExit: () => setRunning(false),
      });
      if (!handle) return false;
      handleRef.current = handle;
      setActive({
        action,
        ranges: resolution.ranges,
        rangesBySide: resolution.rangesBySide,
        primary: resolution.primary,
      });
      setRunning(true);
      return true;
    },
    [context, controller, stop],
  );

  /** Stop following the range without changing playback (P2 is not bound here). */
  const clear = useCallback(() => {
    stop();
    setActive(null);
    setRunning(false);
  }, [stop]);

  return { focus, clear, active, running, enabled: true };
}
