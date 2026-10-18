import { readAMS2DumpFrames } from "@raceiq/capture-formats/ams2/dump";
import { ams2Parser } from "@raceiq/game-ams2/game-parser";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import type { GameId, LapWindow, LiveParserPlan, StreamingMemberStage } from "@raceiq/capture-splitting";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import {
  createLiveGameParserCodec,
  LiveParserEvidenceTracker,
  replayLiveParserStage,
  type LiveGameParserCodec,
} from "../../src/session-capture/live-game-codecs";

interface CounterState { value: number }
const codec: LiveGameParserCodec = {
  createState: (): CounterState => ({ value: 0 }),
  captureState: (state) => Uint8Array.of((state as CounterState).value),
  restoreState: (payload) => {
    if (payload.byteLength !== 1) throw new Error("Invalid counter checkpoint");
    return { value: payload[0]! } satisfies CounterState;
  },
  parseFrame(frame, state): TelemetryPacket | null {
    const counter = state as CounterState;
    counter.value += frame[0]!;
    if (frame[0] === 0) return null;
    return { speed: counter.value } as unknown as TelemetryPacket;
  },
};

function plan(sequence: number, state: number): LiveParserPlan {
  return {
    gameId: "fm-2023" as GameId,
    sequence,
    anchorSequence: sequence,
    anchorPayload: Uint8Array.of(state),
    precedingRecords: [],
  };
}

function frame(offset: number, value: number): SessionCaptureRecord {
  return { kind: "frame", offset, endOffset: offset + 1, frame: Buffer.from([value]) };
}

function stagedRecords(checkpoint: Uint8Array): SessionCaptureRecord[] {
  return [
    { kind: "parser-bootstrap", offset: 0, endOffset: 0, gameId: "fm-2023", formatVersion: 1, payload: Buffer.from(checkpoint) },
    frame(1, 0),
    frame(2, 1),
  ];
}

function stage(records: SessionCaptureRecord[]): Pick<StreamingMemberStage, "readRecords"> {
  return { async *readRecords() { yield* records; } };
}

test("later wrong candidate checkpoint cannot self-validate against independent source parser", async () => {
  const tracker = new LiveParserEvidenceTracker("fm-2023", codec);
  tracker.candidateStart("first", 0, plan(0, 0), false);
  tracker.sourceRecord(frame(0, 2));

  const checkpoint = tracker.candidateStart("later", 1, plan(1, 99), false);
  expect([...checkpoint]).toEqual([99]);
  tracker.sourceRecord(frame(1, 0));
  tracker.sourceRecord(frame(2, 1));

  const lap: LapWindow = {
    lapId: "later-lap",
    lapNumber: 2,
    startByteOffset: 1,
    frameCount: 2,
  };
  tracker.bindCandidate("later", lap.lapId);
  tracker.finalizeWindow(lap);
  const evidence = tracker.takeReplayEvidence(lap);
  expect(evidence).toMatchObject({ sourceFrameCount: 2, parsedFrameCount: 1, nullFrameCount: 1 });
  if (!evidence) throw new Error("Expected source replay evidence");

  await expect(replayLiveParserStage("fm-2023", stage(stagedRecords(checkpoint)), { ...lap, parserCheckpoint: checkpoint }, codec, evidence))
    .rejects.toBeInstanceOf(Error);

  const validCheckpoint = Uint8Array.of(2);
  await expect(replayLiveParserStage("fm-2023", stage(stagedRecords(validCheckpoint)), { ...lap, parserCheckpoint: validCheckpoint }, codec, evidence))
    .resolves.toBeUndefined();
});


test("AMS2 frame-local live codec preserves real driving and menu parser output", async () => {
  const codec = createLiveGameParserCodec("ams2");
  const state = codec.restoreState(codec.captureState(codec.createState()));
  let driving = 0;
  let menus = 0;
  for await (const frame of readAMS2DumpFrames(resolve(import.meta.dir, "../../../../test/artifacts/sessions/ams2-time-trial.bin.gz"))) {
    const actual = codec.parseFrame(frame, state);
    expect(actual).toEqual(ams2Parser.tryParse(frame, null));
    if (actual) driving++;
    else menus++;
  }
  expect(driving).toBeGreaterThan(0);
  expect(menus).toBeGreaterThan(0);
  expect(() => codec.restoreState(Uint8Array.of(1))).toThrow("Unexpected checkpoint");
});
