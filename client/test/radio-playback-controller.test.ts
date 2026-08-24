import { expect, test } from "bun:test";
import type { LiveEngineerVoiceLineMessageV2 } from "../../shared/racing/live/engineer-contracts";
import { LiveEngineerPlaybackSession } from "../src/lib/live-engineer-playback-session";

const line: LiveEngineerVoiceLineMessageV2 = { type: "live-engineer-voice-line", protocolVersion: 2, deliveryId: "delivery-1", decisionId: "decision-1", family: "spotter", mode: "automatic", priority: "high", sourceSequence: 1, catalogVersion: "v1", segmentIds: ["spotter.car-left"] };

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
