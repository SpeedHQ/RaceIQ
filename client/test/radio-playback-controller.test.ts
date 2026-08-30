import { expect, test } from "bun:test";
import type { LiveEngineerVoiceLineMessageV2 } from "../../shared/racing/live/engineer-contracts";
import { DEFAULT_JOIN_GAP_MS, DEFAULT_RADIO_COMPRESSOR, DEFAULT_RADIO_FILTER, LAP_TIME_MINUTE_PAUSE_MS, LiveEngineerAudioPlayer, getSegmentPauseMs, speechBoundsMs } from "../src/lib/live-engineer-audio";
import { LiveEngineerPlaybackSession } from "../src/lib/live-engineer-playback-session";

const line: LiveEngineerVoiceLineMessageV2 = { type: "live-engineer-voice-line", protocolVersion: 2, deliveryId: "delivery-1", decisionId: "decision-1", family: "spotter", mode: "automatic", priority: "high", sourceSequence: 1, catalogVersion: "v1", segmentIds: ["spotter.car-left"] };

test("expired V3 voice line does not start audio and reports terminal expiry", () => {
  const statuses: string[] = [];
  let plays = 0;
  const audio = { play: async () => { plays += 1; }, stop: () => {}, setVolume: () => {} };
  const session = new LiveEngineerPlaybackSession(audio, { enqueueControl: (message) => statuses.push(`${message.status}:${message.reason ?? ""}`), finishVoiceLine: () => {}, setPlayback: () => {} });
  session.start({ ...line, protocolVersion: 3, sessionId: "session-1", timelineEpoch: 4, createdSessionTimeMs: 1200, expiresSessionTimeMs: 2200 } as never, true, 0.8, 2300);
  expect(plays).toBe(0);
  expect(statuses).toContain("failed:expired");
});

test("volume changes update gain without restarting unresolved playback", async () => {
  let resolve!: () => void;
  const statuses: string[] = [];
  const audio = { plays: 0, stops: 0, volumes: [] as number[], play: async () => { audio.plays += 1; await new Promise<void>((done) => { resolve = done; }); }, stop: () => { audio.stops += 1; }, setVolume: (value: number) => { audio.volumes.push(value); } };
  const session = new LiveEngineerPlaybackSession(audio, { enqueueControl: (message) => statuses.push(message.status), finishVoiceLine: () => statuses.push("finish"), setPlayback: () => {} });
  session.start(line, true, 0.8);
  session.setVolume(0.3);
  expect(audio.plays).toBe(1);
  expect(audio.stops).toBe(0);
  expect(audio.volumes).toEqual([0.8, 0.3]);
  expect(statuses).toEqual(["started"]);
  resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(statuses).toEqual(["started", "completed", "finish"]);
});
test("Qwen clip playback uses a 10ms overlap by default", () => {
  expect(DEFAULT_JOIN_GAP_MS).toBe(-10);
});
test("speech bounds ignore per-clip leading and trailing silence", () => {
  expect(speechBoundsMs(new Float32Array([0, 0, 0.02, 0.03, 0, 0]), 1000)).toEqual({ startMs: 2, endMs: 4 });
});
test("radio playback applies a speech-band filter by default", () => {
  const connections: unknown[][] = [];
  const node = () => ({ connect: (target: unknown) => connections.push([target]) });
  const context = {
    createGain: () => ({ ...node(), gain: { value: 0 } }),
    createBiquadFilter: () => ({ ...node(), type: "", frequency: { value: 0 }, Q: { value: 0 } }),
    createDynamicsCompressor: () => ({ ...node(), threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }),
    createWaveShaper: () => ({ ...node(), curve: null, oversample: "none" }),
    destination: {},
  } as unknown as AudioContext;
  const player = new LiveEngineerAudioPlayer({ audioContext: context });
  expect(player).toBeInstanceOf(LiveEngineerAudioPlayer);
  expect(DEFAULT_RADIO_COMPRESSOR).toEqual({ thresholdDb: -24, ratio: 6 });
  expect(connections).toHaveLength(5);
});
test("lap-time minute boundary adds a slight pause", () => {
  expect(LAP_TIME_MINUTE_PAUSE_MS).toBe(100);
  expect(getSegmentPauseMs("unit.minute")).toBe(0.1);
  expect(getSegmentPauseMs("number.one")).toBe(0);
});
