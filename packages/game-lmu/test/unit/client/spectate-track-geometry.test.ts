import { test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { center, origin, geometry, expectOnPaths } from "@raceiq/lap-replay/test-support/spectate-track-geometry";

initGameAdapters({ f1Experiments: true, iracingAdapter: true });
test("LMU preserves native outline coordinates when boundaries are absent", () => {
  const runtime = geometry("lmu", center.slice(0, 2).map(p => ({ x: p.x + 3, z: p.z })));
  runtime.setOutline(center, null);
  expectOnPaths(runtime.edgeRuns, [center.map(p => ({ x: p.x - origin.x, z: p.z - origin.z }))]);
});
