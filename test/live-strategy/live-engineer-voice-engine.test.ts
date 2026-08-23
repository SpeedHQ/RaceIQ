import { expect, test } from "bun:test";
import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";
import { LiveEngineerVoiceEngine } from "../../server/live-strategy/live-engineer-voice-engine";

const ok = (semanticId: string, value: unknown): ResolvedValue<unknown> => ({
  semanticId, value, unit: null, mappingStatus: "direct", state: "ok", confidence: 1, freshness: "fresh",
  confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 },
  provenance: {} as never, schemaVersion: "v7", limitations: [],
});
const missing = (semanticId: string): ResolvedValue<unknown> => ({ ...ok(semanticId, null), state: "missing", confidence: null });
const frame = (sequence: number, lap: number, overrides: Record<string, ResolvedValue<unknown>> = {}) => {
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
    simulator: "f1-2025" as const, sessionId: 1, streamId: "stream", sequence,
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

test("unavailable required pace field suppresses only opponent pace", () => {
  const emitted: unknown[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  engine.consume(frame(0, 1, { "timing.competitor.last-lap-valid": missing("timing.competitor.last-lap-valid") }));
  engine.consume(frame(1, 2, { "timing.competitor.last-lap-valid": missing("timing.competitor.last-lap-valid") }));
  expect(emitted).toHaveLength(0);
});
