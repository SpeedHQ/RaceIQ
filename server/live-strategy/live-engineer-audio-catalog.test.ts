import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as renderer from "./live-engineer-renderer";
import { renderLapTime, renderOpponentLapPace, renderOpponentPace, renderSpotter } from "./live-engineer-renderer";
import { SPOTTER_STATES } from "../../shared/racing/live/spotter-contracts";
import { liveEngineerIntegerAtoms } from "../../shared/racing/live/time-text";

type Manifest = {
  clips: Array<{ segmentId: string; path: string; spokenText: string }>;
  fullLines: Array<{ lineId: string; path: string; spokenText: string }>;
};

const manifest = JSON.parse(readFileSync("client/public/audio/live-engineer/qwen-v2/manifest.json", "utf8")) as Manifest;
const available = new Set(manifest.clips.map((clip) => clip.segmentId));
const rendererSegmentIds = new Set<string>();

function expectRenderedClipsReady(label: string, segmentIds: readonly string[]): void {
  for (const segmentId of segmentIds) rendererSegmentIds.add(segmentId);
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


test("every reachable CrewChief event renders deterministic packaged speech", () => {
  const renderCrewChiefEvent = (renderer as typeof renderer & {
    renderCrewChiefEvent?: (event: unknown, options?: { voiceMode?: string }) => { text: string; segmentIds: readonly string[]; voiceMode: string };
  }).renderCrewChiefEvent;
  expect(typeof renderCrewChiefEvent).toBe("function");
  if (!renderCrewChiefEvent) return;
  const events = [
    ["position-changed", { position: 2, previousPosition: 3 }], ["pre-lights", { sessionPhase: "formation" }],
    ["green-flag", { sessionPhase: "green" }], ["lap-completed", { lapNumber: 4, lapTimeMs: 92_417 }],
    ["opponent-lap-completed", { competitorId: "car-12", lapTimeMs: 91_183 }],
    ["multiclass-traffic", { competitorId: "car-12", class: "GT3", relativeDistance: 0.2 }],
    ["penalty-issued", { penalty: "drive-through" }], ["pit-entry", { pitLane: true }], ["pit-exit", { pitLane: false }],
    ["fuel-low", { fuelPercent: 12 }], ["fuel-critical", { fuelPercent: 4 }], ["flag-change", { current: "black" }], ["flag-change", { current: "blue" }],
    ["tyres-cold", { tyreTemperatureC: 62 }], ["tyres-hot", { tyreTemperatureC: 103 }], ["tyres-cooking", { tyreTemperatureC: 118 }],
    ["water-temperature-hot", { waterTemperatureC: 108 }], ["water-temperature-clear", { waterTemperatureC: 94 }],
    ["damage-reported", { front: 0.45, rear: 0.02, left: 0.01, right: 0.03, centre: 0 }],
  ] as const;
  for (const [eventKey, payload] of events) {
    const rendered = renderCrewChiefEvent({ eventKey, family: "CrewChief", severity: "info", triggerId: `test/${eventKey}`, sessionId: "test-session", timelineEpoch: 1, sourceSequence: 1, sessionTimeMs: 120_000, source: { path: "CrewChiefV4/Events/test.cs", symbols: ["test"] }, payload }, { voiceMode: "automatic" });
    const renderedAgain = renderCrewChiefEvent({ eventKey, family: "CrewChief", severity: "info", triggerId: `test/${eventKey}`, sessionId: "test-session", timelineEpoch: 1, sourceSequence: 1, sessionTimeMs: 120_000, source: { path: "CrewChiefV4/Events/test.cs", symbols: ["test"] }, payload }, { voiceMode: "automatic" });
    expect(renderedAgain).toEqual(rendered);
    expect(rendered.text, eventKey).not.toBe("");
    expect(rendered.segmentIds.length, eventKey).toBeGreaterThan(0);
    const expectedFlag = "current" in payload ? String(payload.current) : "";
    const expectedSegmentId = expectedFlag === "black" ? "race-engineer.black-flag" : expectedFlag === "blue" ? "race-engineer.blue-flag" : eventKey === "flag-change" && expectedFlag === "green" ? "race-engineer.green-flag" : eventKey === "damage-reported" ? "race-engineer.damage-heavy-front" : `race-engineer.${eventKey}`;
    expect(rendered.segmentIds.some((id) => id === expectedSegmentId), eventKey).toBe(true);
    expect(rendered.voiceMode, eventKey).toBe("automatic");
    expectRenderedClipsReady(eventKey, rendered.segmentIds);
  }
});

test("every catalog audio entry has a packaged file", () => {
  for (const clip of [...manifest.clips, ...manifest.fullLines]) {
    expect(Bun.file(`client/public/audio/live-engineer/qwen-v2/${clip.path}`).size, "segmentId" in clip ? clip.segmentId : clip.lineId).toBeGreaterThan(0);
  }
  for (const segmentId of rendererSegmentIds) {
    const clip = manifest.clips.find((entry) => entry.segmentId === segmentId);
    expect(clip, segmentId).toBeDefined();
    if (clip) expect(Bun.file(`client/public/audio/live-engineer/qwen-v2/${clip.path}`).size, segmentId).toBeGreaterThan(0);
  }
});
