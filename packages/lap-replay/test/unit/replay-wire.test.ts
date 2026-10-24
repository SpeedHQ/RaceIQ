import { describe, expect, test } from "bun:test";
import type { LmuLiveContextWire, LmuObservationWire, LmuResolvedValueWire } from "@raceiq/shared/telemetry/lmu-context";
import { createSemanticReplayEncoder, decodeSemanticLapTelemetry, packSemanticLapTelemetry, SEMANTIC_REPLAY_MEDIA_TYPE } from "../../contracts";
import type { SemanticLapTelemetry, SemanticReplayFrame } from "../../contracts";

function resolved(semanticId: string, value: unknown, unit: string | null): LmuResolvedValueWire {
  return {
    semanticId, value, unit, state: "ok", mappingStatus: "direct", confidence: 1, freshness: "fresh",
    confidenceComponents: { semanticFidelity: 1, inputCompleteness: 1, freshness: 1 },
    provenance: {
      simulator: "lmu", parserId: "lmu", parserVersion: "1", resolverVersion: "1", catalogVersion: "1", catalogHash: "fixture",
      observedAt: { domain: "monotonic", nanoseconds: "9007199254740993123" },
      sourceObservation: { timestamp: { domain: "monotonic", nanoseconds: "9007199254740993123" }, updateSequence: "9007199254740993124" },
    },
    schemaVersion: "1", limitations: ["Native source evidence"],
  };
}

function setup(): LmuObservationWire {
  const semanticId = "lmu.rest.garage.setup";
  return {
    semanticId, endpoint: "/rest/garage/getPlayerGarageData", applicability: "player-vehicle", method: "GET",
    sessionKey: "race-1", vehicleId: 42, acquiredAt: { domain: "wall-clock", milliseconds: 1000.125 }, responseVersion: "etag-1",
    observation: resolved(semanticId, { brakes: [1, 2, 3, 4], setup: { label: "full", enabled: false, unset: null } }, null),
  };
}

function context(supplemental: LmuObservationWire[] = []): LmuLiveContextWire {
  return {
    schemaVersion: 1, key: { sessionKey: "race-1", captureSequence: "9007199254740993", frameTime: { domain: "monotonic", nanoseconds: "9007199254740993123" } },
    status: "active", playerVehicleId: 42, supplemental,
    competitors: [{ vehicleId: 42, incarnation: 0, isPlayer: true, channels: { "timing.competitor.total-time": resolved("timing.competitor.total-time", 0, "s") } }],
  };
}

function frame(index: number, lmu?: LmuLiveContextWire): SemanticReplayFrame {
  return {
    sequence: 123 + index,
    observedAt: { domain: "session", milliseconds: 1000.125 + index * 10 },
    receivedAt: { domain: "wall-clock", milliseconds: 2000.875 + index * 10 },
    simulator: "lmu",
    values: [
      { semanticId: "motion.speed", value: 42 + index, unit: "m/s", state: "ok", freshness: "fresh" },
      { semanticId: "nested.fixture", value: { corners: [[0, null], [false, "value"]] }, unit: null },
      { semanticId: "missing.fixture", value: null, state: "missing", freshness: "unknown" },
      { semanticId: "without.metadata", value: false },
    ],
    ...(lmu === undefined ? {} : { lmu }),
  };
}

function lap(envelopes: SemanticReplayFrame[] = [frame(0, context([setup()])), frame(1, context([setup()]))]): SemanticLapTelemetry {
  return {
    lapId: 32, requestedSemanticIds: ["motion.speed", "nested.fixture"], sectorTimes: [12.125, 13.5, 14.875], sectorStarts: null,
    insights: [{ id: "native-aid", category: "driving", severity: "info", label: "Native intervention", detail: "Recorded activation", frameIndices: [0, 1], evidenceSource: "native", timeLossS: 0 }],
    detectorCoverage: [{ id: "native-aid", category: "driving", label: "Native intervention", status: "finding" }, { id: "missing-aid", category: "driving", label: "Missing channel", status: "unavailable", reason: "Not recorded" }],
    parseError: null, envelopes,
  };
}

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("semantic replay wire codec", () => {
  test("round-trips all native 100 Hz samples, metadata, nested values, precise timestamps, contexts and competitors", () => {
    const sample = setup();
    const frames = Array.from({ length: 101 }, (_, index) => frame(index, index === 0 ? undefined : context(index === 1 ? [] : [sample])));
    const changed = structuredClone(sample);
    changed.observation.value = { brakes: [4, 3, 2, 1], setup: { label: "changed", enabled: true, unset: null } };
    frames[3]!.lmu = context([changed]);
    const stale = structuredClone(sample);
    Object.assign(stale.observation, { value: null, state: "stale", freshness: "stale", confidence: null });
    frames[4]!.lmu = context([stale]);
    const error = structuredClone(sample);
    Object.assign(error.observation, { value: null, state: "error", freshness: "unknown", limitations: ["Acquisition failed"] });
    error.acquiredAt = { domain: "monotonic", nanoseconds: "9007199254740993999" };
    frames[5]!.lmu = context([error]);
    const transition = structuredClone(sample);
    transition.sessionKey = "race-2";
    const nextContext = context([transition]);
    nextContext.key = { ...nextContext.key, sessionKey: "race-2", captureSequence: "9007199254740994" };
    nextContext.competitors = nextContext.competitors!.map((entry) => ({ ...entry, incarnation: 1 }));
    frames[6]!.lmu = nextContext;
    const input = lap(frames);
    const compact = packSemanticLapTelemetry(input);
    const decoded = decodeSemanticLapTelemetry(json(compact));
    expect(SEMANTIC_REPLAY_MEDIA_TYPE).toBe("application/vnd.raceiq.semantic-replay+json");
    expect(decoded).toEqual(input);
    expect(decoded.envelopes).toHaveLength(101);
    expect(decoded.envelopes[100]!.observedAt.milliseconds - decoded.envelopes[0]!.observedAt.milliseconds).toBe(1000);
    expect(Object.hasOwn(decoded.envelopes[0]!, "lmu")).toBe(false);
    expect(decoded.envelopes[1]!.lmu!.supplemental).toEqual([]);
    expect(compact.definitions).toHaveLength(4);
    expect(compact.supplemental).toHaveLength(5);
    expect(decoded.envelopes[2]!.lmu!.supplemental[0]).toBe(decoded.envelopes[7]!.lmu!.supplemental[0]);
    expect(decodeSemanticLapTelemetry(json(input))).toEqual(input);
  });

  test("streaming builder interns equal content despite key order, but never merges changed content at the same timestamp", () => {
    const original = setup();
    const reversed = Object.fromEntries(Object.entries(structuredClone(original)).reverse()) as unknown as LmuObservationWire;
    const changed = structuredClone(original);
    changed.observation.value = { changed: true };
    const encoder = createSemanticReplayEncoder();
    const frames = [frame(0, context([original])), frame(1, context([original])), frame(2, context([reversed])), frame(3, context([changed]))];
    for (const entry of frames) encoder.addFrame(entry);
    const expected = lap(frames);
    const { envelopes: _envelopes, ...metadata } = expected;
    const compact = encoder.finish(metadata);
    expect(compact.supplemental).toHaveLength(2);
    expect(compact.envelopes.map((entry) => entry.lmu!.supplemental)).toEqual([[0], [0], [0], [1]]);
    expect(decodeSemanticLapTelemetry(json(compact))).toEqual(expected);
  });

  test("does not rescan the same observation identity during encoding or per-frame dictionary decoding", () => {
    const sample = setup();
    const value = sample.observation.value;
    let reads = 0;
    Object.defineProperty(sample.observation, "value", { enumerable: true, get() { reads++; return value; } });
    const encoder = createSemanticReplayEncoder();
    encoder.addFrame(frame(0, context([sample])));
    const firstReads = reads;
    encoder.addFrame(frame(1, context([sample])));
    expect(reads).toBe(firstReads);
    const compact = encoder.finish({ lapId: 32, requestedSemanticIds: [] });
    reads = 0;
    decodeSemanticLapTelemetry(compact);
    const repeatedReads = reads;
    reads = 0;
    decodeSemanticLapTelemetry({ ...compact, envelopes: compact.envelopes.slice(0, 1) });
    expect(reads).toBe(repeatedReads);
    expect(reads).toBeGreaterThan(0);
  });

  test("retains absent optional metadata and empty contexts with no competitors", () => {
    const empty = context();
    delete empty.competitors;
    const input: SemanticLapTelemetry = { lapId: 1, requestedSemanticIds: [], envelopes: [frame(0), frame(1, empty)] };
    expect(decodeSemanticLapTelemetry(json(packSemanticLapTelemetry(input)))).toEqual(input);
    expect(decodeSemanticLapTelemetry(json(packSemanticLapTelemetry({ ...input, envelopes: [] })))).toEqual({ ...input, envelopes: [] });
  });

  test("separates semantic definitions for null units, missing metadata, state and freshness transitions", () => {
    const input = lap([frame(0)]);
    input.envelopes[0]!.values = [
      { semanticId: "motion.speed", value: 1 },
      { semanticId: "motion.speed", value: 1, unit: null },
      { semanticId: "motion.speed", value: null, unit: null, state: "stale", freshness: "stale" },
      { semanticId: "motion.speed", value: null, unit: null, state: "error", freshness: "unknown" },
    ];
    const compact = packSemanticLapTelemetry(input);
    expect(compact.definitions).toHaveLength(4);
    expect(decodeSemanticLapTelemetry(json(compact))).toEqual(input);
  });

  test.each([-1, 0.5, 4, "0", null, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid definition index %p", (index) => {
    const compact = packSemanticLapTelemetry(lap());
    compact.envelopes[0]!.values = [[index as number, 1]];
    expect(() => decodeSemanticLapTelemetry(compact)).toThrow();
  });

  test.each([-1, 0.5, 1, "0", null, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid supplemental index %p", (index) => {
    const compact = packSemanticLapTelemetry(lap());
    compact.envelopes[0]!.lmu!.supplemental = [index as number];
    expect(() => decodeSemanticLapTelemetry(compact)).toThrow();
  });

  test.each([null, [], [0], [0, 1, 2], { 0: 0, 1: 1 }, [0, undefined], [0, Number.NaN]].map((tuple) => ({ tuple })))("rejects malformed value tuple %p", ({ tuple }) => {
    const compact = packSemanticLapTelemetry(lap());
    compact.envelopes[0]!.values = [tuple] as typeof compact.envelopes[number]["values"];
    expect(() => decodeSemanticLapTelemetry(compact)).toThrow();
  });

  test("rejects unknown format, malformed dictionaries, frames and cross-context references", () => {
    const compact = packSemanticLapTelemetry(lap());
    for (const changes of [
      { format: "raceiq-semantic-replay-v2" }, { format: null }, { definitions: null }, { supplemental: null },
      { definitions: [{ semanticId: 1 }] }, { definitions: [{ semanticId: "motion.speed", value: 2 }] },
      { supplemental: [{}] }, { envelopes: [{}] }, { requestedSemanticIds: [1] },
    ]) expect(() => decodeSemanticLapTelemetry({ ...compact, ...changes })).toThrow();
    for (const changes of [
      { key: { ...compact.envelopes[0]!.lmu!.key, sessionKey: "other-session" } },
      { playerVehicleId: 99, competitors: undefined }, { supplemental: [0, 0] }, { supplemental: null },
      { competitors: [{ vehicleId: 42, incarnation: 0, isPlayer: true, channels: { bad: {} } }] },
    ]) {
      const bad = structuredClone(compact);
      Object.assign(bad.envelopes[0]!.lmu!, changes);
      expect(() => decodeSemanticLapTelemetry(bad)).toThrow();
    }
    const badObservation = structuredClone(compact);
    badObservation.supplemental[0]!.observation.value = 10;
    expect(() => decodeSemanticLapTelemetry(badObservation)).toThrow();
    const expanded = lap();
    expanded.envelopes[0]!.lmu!.key.captureSequence = "-1";
    expect(() => decodeSemanticLapTelemetry(expanded)).toThrow("Invalid LMU historical context");
    for (const changes of [
      { envelopes: Array(1) }, { definitions: Array(1) }, { supplemental: Array(1) },
      { envelopes: [{ ...compact.envelopes[0]!, values: Array(1) }] },
    ]) expect(() => decodeSemanticLapTelemetry({ ...compact, ...changes })).toThrow();
    const sparseContext = structuredClone(compact);
    sparseContext.envelopes[0]!.lmu!.supplemental = Array(1);
    expect(() => decodeSemanticLapTelemetry(sparseContext)).toThrow();
  });
});
