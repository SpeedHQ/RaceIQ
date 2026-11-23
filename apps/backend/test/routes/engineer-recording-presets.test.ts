import { expect, test } from "bun:test";
import type { LiveEngineerSessionReplayV1 } from "@raceiq/shared/racing/live/engineer-replay-contracts";
import { ENGINEER_REPLAY_PRESETS } from "@raceiq/shared/racing/live/engineer-replay-contracts";
import { initServerGameAdapters } from "../../src/games/init";
import { liveEngineerReplayRoutes } from "../../src/routes/dev/live-engineer-replay-routes";

initServerGameAdapters();

async function replay(gameId: string, scenario: string, stream: boolean): Promise<LiveEngineerSessionReplayV1> {
  const query = new URLSearchParams({ gameId, scenario });
  const response = await liveEngineerReplayRoutes.request(`/api/dev/live-engineer/session-replay${stream ? "-stream" : ""}?${query}`);
  if (!response.ok) throw new Error(await response.text());
  if (!stream) return await response.json() as LiveEngineerSessionReplayV1;
  const event = JSON.parse((await response.text()).trimEnd().split("\n").at(-1)!);
  if (event.type !== "result") throw new Error(event.message);
  return event.replay;
}

for (const { recordingGameId: game, backendScenario: scenario } of ENGINEER_REPLAY_PRESETS) {
  test(`${game} fixture produces the same trigger trace through both replay routes without a session ID`, async () => {
    async function trace(stream: boolean) {
      const result = await replay(game, scenario, stream);
      expect(result.gameId).toBe(game);
      const laps = new Set(result.frames.map(frame => frame.values["timing.lap-number"]).filter(lap => typeof lap === "number"));
      expect(laps.size).toBeGreaterThanOrEqual(3);
      const triggers = result.annotations.filter(event => event.stage === "trigger");
      if (game === "fm-2023") {
        const fuel = triggers.filter(event => event.family === "Fuel");
        expect(fuel.map(event => event.action)).toEqual(["fuel-low", "fuel-critical", "pit-this-lap", "pit-pit-pit"]);
        const pit = fuel[2]!;
        expect(result.frames[pit.frameIndex]!.values["timing.lap-number"]).toBe(Number(result.frames[pit.frameIndex - 1]!.values["timing.lap-number"]) + 1);
        expect(result.annotations.some(event => event.audioLineId === "pit-this-lap" && event.candidateId === pit.candidateId)).toBe(true);
        const urgent = fuel[3]!;
        const distance = Number(result.frames[urgent.frameIndex]!.values["timing.distance-traveled"]);
        expect(distance).toBeGreaterThanOrEqual(10_800);
        expect(distance).toBeLessThan(11_000);
        expect(result.annotations.some(event => event.audioLineId === "pit-pit-pit" && event.candidateId === urgent.candidateId)).toBe(true);
      } else if (game === "f1-2025") {
        expect(result.sourceCounts.packets).toBe(185414);
        expect(result.frames.at(-1)?.sourceSequence).toBe(185413);
        expect(result.sourceProfile.segmentCount).toBe(2);
        const pace = result.annotations.filter(event => event.stage === "callout" && event.family === "opponent-pace");
        expect(pace.length).toBeGreaterThan(0);
        for (const event of pace) {
          const candidate = result.annotations.find(item => item.stage === "candidate" && item.candidateId === event.candidateId);
          expect(candidate?.evidence.length).toBeGreaterThan(0);
          expect(result.frames[event.frameIndex]!.sourceSequence).toBeGreaterThan(100);
        }
      }
      return result.annotations.map(event => [event.stage, event.candidateId, event.decisionId, event.action, result.frames[event.frameIndex]!.sourceSequence]);
    }
    const expected = await trace(false);
    expect(await trace(true)).toEqual(expected);
    if (scenario !== "recorded-multi-lap") {
      expect(await trace(false)).toEqual(expected);
      expect(await trace(true)).toEqual(expected);
    }
  }, 600_000);
}

test("sufficient fuel on the same Forza drive suppresses shortage advice", async () => {
  const result = await replay("fm-2023", "sufficient-fuel-control", false);
  expect(result.frames.some(frame => frame.states["fuel.remaining-volume"] === "ok")).toBe(true);
  expect(result.annotations.filter(event => event.family === "Fuel" && event.stage === "trigger")).toEqual([]);
}, 90_000);
