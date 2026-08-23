import { expect, test } from "bun:test";
import { LiveEngineerVoiceEngine } from "../../../server/live-strategy/live-engineer-voice-engine";

test("iRacing live engineer stays silent when required semantics are unavailable", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume({ simulator: "iracing", sessionId: 1, streamId: "s", sequence: 0, observedAt: { domain: "session", milliseconds: 0 }, ids: [], values: [] });
  expect(emitted).toHaveLength(0);
});
