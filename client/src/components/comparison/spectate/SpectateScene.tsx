import { useEffect, useRef, useState } from "react";
import type { SpectateController, SpectatePair } from "./types";
import type { TrackMapBoundaries } from "../../analyse/track-map/types";
import { useSettings } from "@/hooks/settings";
import { useTrackBoundaries } from "@/hooks/track-queries";
import { m } from "@/paraglide/messages";
import { SpectateSceneRuntime } from "./SpectateSceneRuntime";
export interface SpectateSceneProps {
  pair: SpectatePair;
  controller: SpectateController;
  outline: readonly { x: number; z: number }[] | null;
}

/** Canvas owner for the paired recorded-world scene. */
export function SpectateScene({ pair, controller, outline }: SpectateSceneProps) {
  const { displaySettings } = useSettings();
  const boundaries = useTrackBoundaries(pair.comparison.lapA.trackId, pair.gameId).data as TrackMapBoundaries | undefined;
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<SpectateSceneRuntime | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genericModel, setGenericModel] = useState(false);
  const [sideAState, setSideAState] = useState("loading");
  const [sideBState, setSideBState] = useState("loading");
  const key = `${pair.gameId}:${pair.comparison.lapA.id}:${pair.comparison.lapB.id}`;
  useEffect(() => {
    setReady(false);
    setError(null);
    setGenericModel(false);
    setSideAState("loading");
    setSideBState("loading");
    const node = host.current;
    if (!node) return;
    let mounted = true;
    const current = new SpectateSceneRuntime(
      node,
      pair,
      controller,
      (value) => {
        if (mounted) {
          setReady(value);
          setGenericModel(value && (runtime.current?.hasGenericModel ?? false));
          setSideAState(runtime.current?.canvas.dataset.sideAState ?? "loading");
          setSideBState(runtime.current?.canvas.dataset.sideBState ?? "loading");
        }
      },
      (message) => {
        if (mounted) {
          setError(message || null);
          setSideAState(runtime.current?.canvas.dataset.sideAState ?? "unavailable");
          setSideBState(runtime.current?.canvas.dataset.sideBState ?? "unavailable");
        }
      },
      new URLSearchParams(location.search).get("forceWebGL") === "true",
      displaySettings.renderFpsCap,
    );
    runtime.current = current;
    return () => {
      mounted = false;
      runtime.current = null;
      current.dispose();
    };
  }, [key, controller, displaySettings.renderFpsCap]);
  useEffect(() => {
    runtime.current?.setOutline(outline, boundaries ?? null);
  }, [outline, boundaries, key, controller, displaySettings.renderFpsCap]);
  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden bg-app-bg"
      data-spectate-scene=""
      data-scene-ready={ready ? "true" : "false"}
      data-scene-error={error ?? ""}
      data-side-a-state={sideAState}
      data-side-b-state={sideBState}
    >
      <div ref={host} className="absolute inset-0" />
      {error && (
        <div role="alert" className="absolute inset-x-4 top-4 z-10 flex items-center justify-between gap-3 border border-app-border bg-app-surface p-3 text-app-body text-app-text">
          <span>
            {m.spectate_scene_error({
              detail: error === "scene.model-unavailable" ? m.spectate_model_unavailable() : error === "scene.pose-unavailable" ? m.spectate_pose_unavailable() : m.spectate_renderer_unavailable(),
            })}
          </span>
          <button type="button" className="rounded-sm border border-app-border-input px-3 py-1 text-app-label text-app-text-secondary hover:text-app-accent" onClick={() => runtime.current?.retry()}>
            {m.spectate_retry()}
          </button>
        </div>
      )}
      {!error && ready && [sideAState, sideBState].some((state) => state.endsWith("unavailable")) && (
        <div role="status" className="absolute right-3 top-3 z-10 max-w-[16rem] rounded-sm border border-app-border bg-app-surface/90 p-2 text-app-label text-status-unavailable">
          {[sideAState, sideBState].map((state, index) =>
            state.endsWith("unavailable") ? (
              <p key={index}>
                {index === 0 ? "A" : "B"}: {state === "model-unavailable" ? m.spectate_model_unavailable() : m.spectate_pose_unavailable()}
              </p>
            ) : null,
          )}
          <button type="button" className="mt-1 text-app-accent" onClick={() => runtime.current?.retry()}>
            {m.spectate_retry()}
          </button>
        </div>
      )}
      {genericModel && (
        <div className="absolute bottom-3 left-3 z-10 rounded-sm border border-app-border bg-app-surface/90 px-2 py-1 text-app-label text-app-text-secondary max-[800px]:bottom-auto max-[800px]:top-56">{m.spectate_generic_model()}</div>
      )}
      {!ready && !error && (
        <div role="status" className="absolute inset-x-4 top-4 z-10 border border-app-border bg-app-surface p-3 text-app-label text-app-text-secondary">
          {m.spectate_scene_loading()}
        </div>
      )}
    </div>
  );
}
