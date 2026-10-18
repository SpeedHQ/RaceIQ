import { useEffect, useMemo, useRef, useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import { useLapSemanticTelemetry } from "@/hooks/laps";
import { useSettings } from "@/hooks/settings";
import { createSpectateController, prepareSpectateLap } from "@/lib/spectate-replay";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { SpectateView } from "./SpectateView";
import type { SpectateController, SpectatePair, SpectateSegment } from "./types";

/** Kept above the conditional body: tabs preserve location, but never autoplay. */
export function SpectateSession({
  gameId,
  comparison,
  active,
  outline,
  segments,
  distanceRef,
  onDistanceChange,
  cursor,
}: {
  gameId: GameId;
  comparison: ComparisonData;
  active: boolean;
  outline: readonly { x: number; z: number }[] | null;
  segments: readonly SpectateSegment[];
  distanceRef: { current: number | null };
  onDistanceChange: (distance: number | null) => void;
  cursor?: number;
}) {
  const { displaySettings } = useSettings();
  const fpsCap = useRef(displaySettings.renderFpsCap);
  fpsCap.current = displaySettings.renderFpsCap;
  const [requested, setRequested] = useState(active);
  useEffect(() => {
    if (active) setRequested(true);
  }, [active]);
  const replayA = useLapSemanticTelemetry(requested ? comparison.lapA.id : null);
  const replayB = useLapSemanticTelemetry(requested ? comparison.lapB.id : null);
  const pair = useMemo<SpectatePair | null>(() => {
    if (!replayA.data || !replayB.data) return null;
    return { gameId, comparison, a: prepareSpectateLap(replayA.data, comparison, "a"), b: prepareSpectateLap(replayB.data, comparison, "b") };
  }, [gameId, comparison, replayA.data, replayB.data]);
  const [controller, setController] = useState<SpectateController | null>(null);
  const distanceCallback = useRef(onDistanceChange);
  distanceCallback.current = onDistanceChange;
  useEffect(() => {
    if (!pair) return;
    const next = createSpectateController(pair.a, pair.b, distanceRef.current ?? undefined, () => fpsCap.current);
    setController(next);
    return () => {
      next.dispose();
    };
  }, [pair, distanceRef]);
  useEffect(() => {
    if (!controller) return;
    if (active) {
      if (distanceRef.current != null) controller.seekDistance(distanceRef.current, true);
      controller.setActive(true);
    } else {
      controller.setActive(false);
      distanceCallback.current(controller.getSnapshot().a?.distance ?? null);
    }
    return () => controller.setActive(false);
  }, [active, controller, distanceRef]);
  const appliedCursor = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (cursor == null) {
      appliedCursor.current = undefined;
      return;
    }
    if (!controller || !active || appliedCursor.current === cursor) return;
    const distances = comparison.traces.distance;
    const distance = distances[Math.max(0, Math.min(distances.length - 1, Math.floor(cursor)))];
    if (distance == null) return;
    controller.seekDistance(distance, true);
    appliedCursor.current = cursor;
  }, [cursor, controller, comparison, active]);
  if (!active) return null;
  const error = replayA.error ?? replayB.error;
  if (error)
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 text-app-detail text-status-danger">
        <p>{m.spectate_replay_failed()}</p>
        <p>{error.message}</p>
        <Button
          variant="app-outline"
          onClick={() => {
            void replayA.refetch();
            void replayB.refetch();
          }}
        >
          {m.spectate_retry()}
        </Button>
      </div>
    );
  if (!pair || !controller)
    return (
      <div role="status" className="flex flex-1 items-center justify-center text-app-detail text-app-text-muted">
        {m.compare_loading()}
      </div>
    );
  if (pair.a.samples.length < 2 || pair.b.samples.length < 2)
    return (
      <div role="alert" className="flex flex-1 items-center justify-center text-app-detail text-status-unavailable">
        {m.spectate_replay_unavailable()}
      </div>
    );
  return <SpectateView pair={pair} controller={controller} outline={outline} segments={segments} />;
}
