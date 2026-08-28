import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderLapTime, renderOpponentLapPace, renderOpponentPace, renderSpotter } from "./live-engineer-renderer";
import { SPOTTER_STATES } from "../../shared/racing/live/spotter-contracts";
import { liveEngineerIntegerAtoms } from "../../shared/racing/live/time-text";

type Manifest = {
  clips: Array<{ segmentId: string; path: string; spokenText: string }>;
  fullLines: Array<{ lineId: string; path: string; spokenText: string }>;
};

const manifest = JSON.parse(readFileSync("client/public/audio/live-engineer/qwen-v1/manifest.json", "utf8")) as Manifest;
const available = new Set(manifest.clips.map((clip) => clip.segmentId));

function expectRenderedClipsReady(label: string, segmentIds: readonly string[]): void {
  expect(segmentIds.filter((id) => !available.has(id)), label).toEqual([]);
}

test("all live engineer renderer combinations resolve to rendered Qwen clips", () => {
  for (const scope of ["class", "overall"] as const) {
    for (const relation of ["fastest-in-class", "setting-race-pace", "within-class-pace", "off-class-pace", "outlier-lap"] as const) {
      expectRenderedClipsReady(`${relation}/${scope}`, renderOpponentPace({ relation, scope, playerLapNumber: 3, playerLapTimeMs: 92_417, benchmarkLapTimeMs: 91_183, deltaMs: 1234, benchmarkKind: "session-best" }, { voiceMode: "exact-response" }).segmentIds);
    }
  }
  expectRenderedClipsReady("opponent-lap-pace", renderOpponentLapPace({ relation: "within-class-pace", scope: "class", playerLapNumber: 3, playerLapTimeMs: 92_417, benchmarkLapTimeMs: 91_183, deltaMs: 1234, benchmarkKind: "session-best" }, { voiceMode: "exact-response" }).segmentIds);

  for (let value = 0; value <= 999; value += 1) {
    expectRenderedClipsReady(`number/${value}`, liveEngineerIntegerAtoms(value).map((atom) => `number.${atom}`));
  }

  for (const lapTimeMs of [1, 59_001, 60_000, 1_032_417, 10 * 60_000 + 59_999]) {
    expectRenderedClipsReady(`lap/${lapTimeMs}`, renderLapTime(lapTimeMs).segmentIds);
  }

  for (const state of SPOTTER_STATES) {
    expectRenderedClipsReady(`spotter/${state}`, renderSpotter(state).segmentIds);
  }
});


test("every catalog audio entry has a packaged file", () => {
  for (const clip of [...manifest.clips, ...manifest.fullLines]) {
    expect(Bun.file(`client/public/audio/live-engineer/qwen-v1/${clip.path}`).size, "segmentId" in clip ? clip.segmentId : clip.lineId).toBeGreaterThan(0);
  }
});
