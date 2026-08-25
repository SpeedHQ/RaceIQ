import { expect, test } from "bun:test";
import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";
import { LiveEngineerVoiceEngine } from "../../server/live-strategy/live-engineer-voice-engine";

const ok = (semanticId: string, value: unknown): ResolvedValue<unknown> => ({
  semanticId, value, unit: null, mappingStatus: "direct", state: "ok", confidence: 1, freshness: "fresh",
  confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 },
  provenance: {} as never, schemaVersion: "v7", limitations: [],
});
const missing = (semanticId: string): ResolvedValue<unknown> => ({ ...ok(semanticId, null), state: "missing", confidence: null });
const familyOf = (message: unknown): string | undefined => typeof message === "object" && message !== null && "family" in message && typeof message.family === "string" ? message.family : undefined;
const frame = (sequence: number, lap: number, overrides: Record<string, ResolvedValue<unknown>> = {}, simulator: "f1-2025" | "iracing" = "f1-2025") => {
  const values: Record<string, unknown> = {
    "identity.player-car-index": 0, "identity.player-car-class-id": "gt3", "identity.player-track-surface": "track",
    "timing.lap-number": lap, "timing.last-lap": 90, "timing.current-lap-valid": true, "race.pit-status": "on-track",
    "race.session-type": "practice", "session.session-type": "practice", "race.competitor.car-index": [1], "race.competitor.driver-id": ["opp"],
    "race.competitor.driver-name": ["Opponent"], "race.competitor.car-class-id": ["gt3"], "race.competitor.car-class-name": ["GT3"],
    "race.competitor.laps-complete": [lap], "race.competitor.pit-status": ["on-track"], "race.competitor.track-location": ["track"],
    "timing.competitor.last-lap-time": [88], "timing.competitor.last-lap-valid": [true],
    "race.safety-car-status": false, "race.flag-status": "green", "session.session-flags": 0,
  };
  const ids = [...new Set([...Object.keys(values), ...Object.keys(overrides)])];
  return {
    simulator, sessionId: 1, streamId: "stream", sequence,
    observedAt: { domain: "session" as const, milliseconds: sequence * 1000 }, ids,
    values: ids.map((id) => overrides[id] ?? (id in values ? ok(id, values[id]) : missing(id))),
  };
};

test("unrelated missing semantics do not suppress opponent pace", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1, { "damage.engine-damage": missing("damage.engine-damage"), "race.safety-car-status": missing("race.safety-car-status") }));
  engine.consume(frame(1, 2, { "damage.engine-damage": missing("damage.engine-damage"), "race.safety-car-status": missing("race.safety-car-status") }));
  expect(emitted.some((message) => (message as { type?: string }).type === "live-engineer-callout")).toBe(true);
});
test("returns exact pace response for latest automatic decision", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1));
  engine.consume(frame(1, 2));
  const callout = emitted.find((message) => (message as { type?: string }).type === "live-engineer-callout") as { decisionId: string } | undefined;
  expect(callout).toBeDefined();
  const response = engine.handle({ type: "live-engineer-voice-request", protocolVersion: 2, action: "exact-pace", requestId: "req-1", decisionId: callout!.decisionId });
  expect(response?.type).toBe("live-engineer-voice-line");
  expect(response?.mode).toBe("exact-response");
  expect(response?.requestId).toBe("req-1");
});

test("does not benchmark player car against itself", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  const first = {
    "race.competitor.car-index": ok("race.competitor.car-index", [0, 7]),
    "race.competitor.driver-id": ok("race.competitor.driver-id", ["player", "opponent"]),
    "race.competitor.driver-name": ok("race.competitor.driver-name", ["Player", "Opponent"]),
    "race.competitor.car-class-id": ok("race.competitor.car-class-id", ["gt3", "gt3"]),
    "race.competitor.car-class-name": ok("race.competitor.car-class-name", ["GT3", "GT3"]),
    "race.competitor.laps-complete": ok("race.competitor.laps-complete", [1, 1]),
    "race.competitor.pit-status": ok("race.competitor.pit-status", ["on-track", "on-track"]),
    "race.competitor.track-location": ok("race.competitor.track-location", ["track", "track"]),
    "timing.competitor.last-lap-time": ok("timing.competitor.last-lap-time", [60, 88]),
    "timing.competitor.last-lap-valid": ok("timing.competitor.last-lap-valid", [true, true]),
  };
  const second = { ...first, "race.competitor.laps-complete": ok("race.competitor.laps-complete", [2, 2]) };
  engine.consume(frame(0, 1, first));
  engine.consume(frame(1, 2, second));
  const callout = emitted.find((message) => (message as { type?: string }).type === "live-engineer-callout") as { render?: { parameters?: { benchmarkLapTimeMs?: number } } } | undefined;
  expect(callout?.render?.parameters?.benchmarkLapTimeMs).toBe(88_000);
});

test("unavailable required pace field suppresses only opponent pace", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1, { "timing.competitor.last-lap-valid": missing("timing.competitor.last-lap-valid") }));
  engine.consume(frame(1, 2, { "timing.competitor.last-lap-valid": missing("timing.competitor.last-lap-valid") }));
  expect(emitted).toHaveLength(0);
});
test("F1 positional Spotter emits when pace semantics are unavailable", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1, {
    "timing.competitor.last-lap-valid": missing("timing.competitor.last-lap-valid"),
    "race.competitor.car-index": ok("race.competitor.car-index", [0, 1]),
    "race.competitor.connected": ok("race.competitor.connected", [true, true]),
    "race.competitor.position-x": ok("race.competitor.position-x", [0, 2.2]),
    "race.competitor.pit-status": ok("race.competitor.pit-status", ["on-track", "on-track"]),
    "race.competitor.position-z": ok("race.competitor.position-z", [0, -1]),
    "race.competitor.speed": ok("race.competitor.speed", [20, 20]),
    "motion.position-x": ok("motion.position-x", 0),
    "motion.position-z": ok("motion.position-z", 0),
    "motion.speed": ok("motion.speed", 20),
    "motion.yaw": ok("motion.yaw", 0),
  }));
  expect(emitted.some((message) => (message as { family?: string }).family === "spotter")).toBe(true);
});
test("iRacing conservative lap validity accepts track and rejects pit road", () => {
  const overrides = (laps: number[], pit: boolean) => ({
    "timing.competitor.last-lap-valid": missing("timing.competitor.last-lap-valid"),
    "race.competitor.laps-complete": ok("race.competitor.laps-complete", laps),
    "race.competitor.track-location": ok("race.competitor.track-location", [2]),
    "race.competitor.pit-status": ok("race.competitor.pit-status", [pit]),
  });
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1, overrides([1], false), "iracing"));
  engine.consume(frame(1, 2, overrides([2], false), "iracing"));
  expect(emitted.some((message) => (message as { family?: string }).family === "opponent-pace")).toBe(true);
  const pitEmitted: unknown[] = [];
  const pitEngine = new LiveEngineerVoiceEngine({ emit: (message) => pitEmitted.push(message) });
  pitEngine.consume(frame(0, 1, overrides([1], true), "iracing"));
  pitEngine.consume(frame(1, 2, overrides([2], true), "iracing"));
  expect(pitEmitted).toHaveLength(0);
});

test("ACC broadcast semantics emit pace and spotter callouts", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  const make = (sequence: number, lap: number) => {
    const values: Record<string, unknown> = {
      "identity.player-car-index": 0, "identity.player-car-class-id": "gt3", "identity.player-track-surface": "track",
      "timing.lap-number": lap, "timing.last-lap": 90, "timing.current-lap-valid": true, "race.pit-status": "out",
      "session.session-type": "practice", "race.competitor.car-index": [0, 1], "race.competitor.driver-id": ["p", "o"],
      "race.competitor.driver-name": ["Player", "Opponent"], "race.competitor.car-class-id": ["gt3", "gt3"], "race.competitor.car-class-name": ["GT3", "GT3"],
      "race.competitor.laps-complete": [lap, lap], "race.competitor.pit-status": ["out", "out"], "race.competitor.track-location": ["track", "track"],
      "timing.competitor.last-lap-time": [90, 88], "timing.competitor.last-lap-valid": [true, true],
      "motion.position-x": 0, "motion.position-z": 0, "motion.speed": 20, "motion.yaw": 0,
      "race.competitor.position-x": [0, 2.2], "race.competitor.position-z": [0, -1], "race.competitor.speed": [20, 20],
    };
    const ids = Object.keys(values);
    return { simulator: "acc" as const, sessionId: 1, streamId: "acc", sequence, observedAt: { domain: "session" as const, milliseconds: sequence * 1000 }, ids, values: ids.map((id) => ok(id, values[id])) };
  };
  engine.consume(make(0, 1));
  engine.consume(make(1, 2));
  expect(emitted.some((message) => familyOf(message) === "spotter")).toBe(true);
  expect(emitted.some((message) => familyOf(message) === "opponent-pace")).toBe(true);
});
