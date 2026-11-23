import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { registerGame } from "@raceiq/shared/games/registry";
import { gameAdaptersForFeatures } from "@raceiq/game-catalogs/games/init";
import { normalizeAMS2Frame } from "../../../game-ams2/src/normalizer";
import type { ReplayHost } from "../../contracts/host";
import type { ReplaySession, SpectateLap } from "../../contracts/spectate";
import { ReplayProvider } from "../../ui/host";
import { SpectateInputs } from "../../ui/SpectateInputs";
import { createSpectateController } from "../../ui/spectate-replay";

for (const adapter of gameAdaptersForFeatures({ f1Experiments: true, iracingAdapter: true, ams2Adapter: true })) registerGame(adapter);

// Supply only host services used by this component; SSR does not load 3D models.
const host = {
  m: new Proxy({}, { get: (_, key) => () => String(key) }),
  models: { loadCarModelConfigs: async () => {} },
  useUnits: () => ({ speed: (value: number) => value, speedLabel: "m/s" }),
} as unknown as ReplayHost;

function lap(steer: number): SpectateLap {
  return {
    samples: [0, 0.1].map(time => ({ time, distance: time * 20, run: 0, values: { "inputs.steer": steer } })),
    duration: 0.1, distance: 2, hasProgress: true,
    replay: { requestedIds: [], envelopes: [], frames: [] } as unknown as SpectateLap["replay"],
  };
}

function render(gameId: ReplaySession["gameId"], steerA: number, steerB?: number) {
  const a = lap(steerA), b = steerB === undefined ? null : lap(steerB);
  const metadata = { carId: "test-car" } as ReplaySession["comparison"]["lapA"];
  const pair: ReplaySession = { gameId, a, b, comparison: { lapA: metadata, lapB: b ? metadata : null } };
  const controller = createSpectateController(a, b);
  try {
    const markup = renderToStaticMarkup(<ReplayProvider host={host}><SpectateInputs pair={pair} controller={controller} /></ReplayProvider>);
    const svg = markup.match(/<svg viewBox="0 0 160 60"[\s\S]*?<\/svg>/)?.[0];
    expect(svg).toBeDefined();
    const markers = [...svg!.matchAll(/<line x1="([^"]+)" x2="([^"]+)" y1="([^"]+)"/g)];
    for (const marker of markers) expect(marker[1]).toBe(marker[2]);
    return { markers: markers.map(marker => ({ x: Number(marker[1]), y: Number(marker[3]) })), text: markup.replace(/<[^>]*>/g, "") };
  } finally { controller.dispose(); }
}

const games = ["ams2", "lmu", "f1-2025", "fm-2023", "acc", "ac-evo", "iracing"] as const;
for (const game of games) {
  describe(`${game} steering presentation`, () => {
    for (const [steer, positiveRightX] of [[40, 144], [0, 80], [-40, 16]] as const) {
      const expectedX = game === "ams2" || game === "lmu" ? 160 - positiveRightX : positiveRightX;
      test(`single-lap Replay/Analyse preserves ${steer} and places marker at ${expectedX}`, () => {
        const result = render(game, steer);
        expect(result.markers).toEqual([{ x: expectedX, y: 8 }]);
        expect(result.text).toContain(steer.toFixed(2));
      });
      test(`comparison independently positions both markers for ${steer}`, () => {
        const result = render(game, steer, -steer);
        expect(result.markers).toEqual([{ x: expectedX, y: 8 }, { x: 160 - expectedX, y: 31 }]);
        expect(result.text).toContain(`A ${steer.toFixed(2)}`);
        expect(result.text).toContain(`B ${(-steer).toFixed(2)}`);
      });
    }
  });
}

for (const fixture of ["ams2-time-trial", "ams2-race-pit-stop", "ams2-weekend-sparse-qualifying", "ams2-qualifying"]) {
  test(`${fixture}: existing native records retain numeric steering and render with AMS2 direction`, () => {
    const bytes = gunzipSync(readFileSync(new URL(`../../../../test/artifacts/sessions/${fixture}.bin.gz`, import.meta.url)));
    const values = new Map<number, number>();
    for (let offset = 16; offset < bytes.length && values.size < 3;) {
      const size = bytes.readUInt32LE(offset); offset += 4;
      const packet = normalizeAMS2Frame(bytes.subarray(offset, offset + size)); offset += size;
      if (packet) values.set(Math.sign(packet.Steer), packet.Steer);
    }
    expect([...values.keys()].sort()).toEqual([-1, 0, 1]);
    for (const [sign, value] of values) {
      const result = render("ams2", value);
      expect(result.markers).toEqual([{ x: sign > 0 ? 16 : sign < 0 ? 144 : 80, y: 8 }]);
      expect(result.text).toContain(value.toFixed(2));
    }
  });
}
