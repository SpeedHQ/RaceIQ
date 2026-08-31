import { expect, test } from "bun:test";
import type { GameId } from "../../shared/games/ids";
import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";
import { LiveEngineerVoiceEngine } from "../../server/live-strategy/live-engineer-voice-engine";
import { crewChiefSource } from "../../server/live-strategy/crewchief-triggers/contracts";

const ok = (semanticId: string, value: unknown): ResolvedValue<unknown> => ({
  semanticId, value, unit: null, mappingStatus: "direct", state: "ok", confidence: 1, freshness: "fresh",
  confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 },
  provenance: {} as never, schemaVersion: "v7", limitations: [],
});
const missing = (semanticId: string): ResolvedValue<unknown> => ({ ...ok(semanticId, null), state: "missing", confidence: null });
const messagesOfType = (messages: readonly unknown[], type: string): Record<string, unknown>[] =>
  messages.filter((message): message is Record<string, unknown> =>
    typeof message === "object" && message !== null && "type" in message && message.type === type);
const familyOf = (message: unknown): string | undefined => typeof message === "object" && message !== null && "family" in message && typeof message.family === "string" ? message.family : undefined;
const frame = (sequence: number, lap: number, overrides: Record<string, ResolvedValue<unknown>> = {}, simulator: GameId = "acc") => {
  const values: Record<string, unknown> = {
    "identity.player-car-index": 0, "identity.player-car-class-id": "gt3", "identity.player-track-surface": 3,
    "timing.lap-number": lap, "timing.last-lap": 90, "timing.current-lap-valid": true, "race.pit-status": "out", "race.on-pit-road": false,
    "session.session-state": 5, "session.session-type": "practice", "race.competitor.car-index": [1], "race.competitor.connected": [true], "race.competitor.driver-id": ["opp"],
    "race.competitor.driver-name": ["Opponent"], "race.competitor.car-class-id": ["gt3"], "race.competitor.car-class-name": ["GT3"],
    "race.competitor.laps-complete": [lap], "race.competitor.pit-status": ["out"],
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
  const response = engine.handle({ type: "live-engineer-voice-request", protocolVersion: 3, action: "exact-pace", requestId: "req-1", decisionId: callout!.decisionId });
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
    "race.competitor.connected": ok("race.competitor.connected", [true, true]),
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
test("F1 Live Engineer stays disabled even with usable pace and spotter data", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1, {
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
  }, "f1-2025"));
  engine.consume(frame(1, 2, {
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
  }, "f1-2025"));
  expect(emitted).toHaveLength(0);
});

test("ACC broadcast semantics emit pace and spotter callouts", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  const make = (sequence: number, lap: number) => {
    const values: Record<string, unknown> = {
      "identity.player-car-index": 0, "identity.player-car-class-id": "gt3", "identity.player-track-surface": 3,
      "timing.lap-number": lap, "timing.last-lap": 90, "timing.current-lap-valid": true, "race.pit-status": "out",
      "session.session-state": 5, "session.session-type": "practice", "race.competitor.car-index": [0, 1], "race.competitor.connected": [true, true], "race.competitor.driver-id": ["p", "o"],
      "race.competitor.driver-name": ["Player", "Opponent"], "race.competitor.car-class-id": ["gt3", "gt3"], "race.competitor.car-class-name": ["GT3", "GT3"],
      "race.competitor.laps-complete": [lap, lap], "race.competitor.pit-status": ["out", "out"],
      "timing.competitor.last-lap-time": [90, 88], "timing.competitor.last-lap-valid": [true, true],
      "motion.position-x": 0, "motion.position-z": 0, "motion.speed": 20, "motion.yaw": 0,
      "motion.competitor.position-x": [0, 2.2], "motion.competitor.position-z": [0, -1], "motion.competitor.speed": [20, 20],
    };
    const ids = Object.keys(values);
    return { simulator: "acc" as const, sessionId: 1, streamId: "acc", sequence, observedAt: { domain: "session" as const, milliseconds: sequence * 1000 }, ids, values: ids.map((id) => ok(id, values[id])) };
  };
  engine.consume(make(0, 1));
  engine.consume(make(1, 2));
  expect(emitted.some((message) => familyOf(message) === "spotter")).toBe(true);
  expect(emitted.some((message) => familyOf(message) === "opponent-pace")).toBe(true);
});
test("invalidity remains latched when pace disappears during lap", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1));
  engine.consume(frame(1, 1, { "timing.current-lap-valid": ok("timing.current-lap-valid", false), "race.competitor.connected": missing("race.competitor.connected") }));
  engine.consume(frame(2, 2));
  expect(emitted.filter((message) => familyOf(message) === "opponent-pace")).toHaveLength(0);
});

test("lap boundary without pace data is consumed once", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1));
  engine.consume(frame(1, 2, { "race.competitor.connected": missing("race.competitor.connected") }));
  engine.consume(frame(2, 3));
  expect(emitted.filter((message) => familyOf(message) === "opponent-pace")).toHaveLength(0);
});

test("unsupported simulators stay silent even when given usable semantic frames", () => {
  for (const simulator of ["f1-2025", "iracing", "fm-2023", "ac-evo"] as const) {
    const emitted: unknown[] = [];
    const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
    engine.consume(frame(0, 1, {}, simulator));
    engine.consume(frame(1, 2, {}, simulator));
    expect(emitted, simulator).toHaveLength(0);
  }
});

test("iRacing native Spotter emits a V3 callout", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1, { "identity.car-left-right": ok("identity.car-left-right", 2) }, "iracing"));
  expect(emitted.some((message) => familyOf(message) === "spotter")).toBe(true);
});
test("ACC fuel-low structured trigger emits matching V3 callout and voice line", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  const semanticFrame = frame(7, 3);
  engine.consume({
    streamId: semanticFrame.streamId,
    sessionId: "1",
    timelineEpoch: 12,
    sourceSequence: 7,
    sessionTimeMs: 3456,
    context: { simulator: "acc", sessionActive: true, formation: false, caution: false, pit: false, spectating: false },
    semanticFrame,
    events: [{
      eventKey: "fuel-low",
      family: "Fuel",
      severity: "warning",
      triggerId: "stream/12/7/Fuel/fuel-low/0",
      sessionId: "1",
      timelineEpoch: 12,
      sourceSequence: 7,
      sessionTimeMs: 3456,
      source: crewChiefSource("Fuel"),
      payload: {},
      evidenceSemanticIds: [],
    }],
  });
  const callouts = messagesOfType(emitted, "live-engineer-callout");
  const lines = messagesOfType(emitted, "live-engineer-voice-line");
  expect(callouts).toHaveLength(1);
  expect(lines).toHaveLength(1);
  expect(callouts[0]).toMatchObject({ family: "race-engineer", sessionId: "1", timelineEpoch: 12, sourceSequence: 7, expiresSessionTimeMs: 3456 + 12_000, render: { renderingVersion: "crewchief-v1", parameters: { triggerFamily: "Fuel", eventKey: "fuel-low" } } });
  expect(lines[0]).toMatchObject({ sessionId: "1", timelineEpoch: 12, sourceSequence: 7 });
});

test("structured batch epoch remains authoritative across reset and stream changes", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  const makeBatch = (streamId: string, epoch: number, sequence: number) => {
    const semanticFrame = { ...frame(sequence, 1), streamId };
    return {
      streamId, sessionId: "1", timelineEpoch: epoch, sourceSequence: sequence, sessionTimeMs: sequence * 100,
      context: { simulator: "acc" as const, sessionActive: true, formation: false, caution: false, pit: false, spectating: false },
      semanticFrame,
      events: [{
        eventKey: "fuel-low", family: "Fuel" as const, severity: "warning" as const,
        triggerId: `${streamId}/${epoch}/${sequence}`, sessionId: "1", timelineEpoch: epoch,
        sourceSequence: sequence, sessionTimeMs: sequence * 100, source: crewChiefSource("Fuel"),
        payload: {}, evidenceSemanticIds: [],
      }],
    };
  };
  engine.consume(makeBatch("one", 4, 1));
  engine.reset();
  engine.consume(makeBatch("two", 9, 2));
  expect(messagesOfType(emitted, "live-engineer-callout").map((message) => message.timelineEpoch)).toEqual([4, 9]);
});
