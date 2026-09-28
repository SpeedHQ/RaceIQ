import { expect, test } from "bun:test";
import {
  isLiveEngineerCalloutMessageV3,
  isLiveEngineerDeliveryStatusV3,
  isLiveEngineerVoiceLineMessageV3,
  isLiveEngineerVoiceRequestV3,
} from "../../shared/racing/live/engineer-contracts";
import { crewChiefSource } from "../../server/live-strategy/crewchief-triggers/contracts";
import { WebSocketManager } from "../../server/runtime/websocket-manager";

const v3Voice = {
  type: "live-engineer-voice-line",
  protocolVersion: 3,
  deliveryId: "delivery-1",
  decisionId: "decision-1",
  family: "spotter",
  mode: "automatic",
  priority: "high",
  sourceSequence: 1,
  catalogVersion: "v1",
  segmentIds: ["spotter.car-left"],
  sessionId: "session-1",
  timelineEpoch: 7,
  createdSessionTimeMs: 100,
  expiresSessionTimeMs: 900,
} as const;
const raceEngineerCallout = {
  type: "live-engineer-callout",
  protocolVersion: 3,
  decisionId: "fuel-low/race-engineer-v3",
  candidateId: "fuel-low",
  family: "race-engineer",
  sessionId: "session-1",
  timelineEpoch: 7,
  sourceSequence: 1,
  priority: "normal",
  createdSessionTimeMs: 100,
  expiresSessionTimeMs: 12_100,
  render: {
    renderingVersion: "crewchief-v1",
    text: "Fuel is low.",
    textKey: "fuel-low",
    parameters: {
      triggerFamily: "Fuel",
      eventKey: "fuel-low",
      payload: { remainingLaps: 1.9 },
      source: crewChiefSource("Fuel"),
    },
  },
} as const;

test("accepts V3 voice metadata and rejects missing expiry", () => {
  expect(isLiveEngineerVoiceLineMessageV3(v3Voice)).toBe(true);
  expect(isLiveEngineerVoiceLineMessageV3({ ...v3Voice, expiresSessionTimeMs: undefined })).toBe(false);
});

test("accepts pinned CrewChief race-engineer callouts", () => {
  expect(isLiveEngineerCalloutMessageV3(raceEngineerCallout)).toBe(true);
  expect(isLiveEngineerCalloutMessageV3({
    ...raceEngineerCallout,
    render: {
      ...raceEngineerCallout.render,
      parameters: {
        ...raceEngineerCallout.render.parameters,
        source: { ...raceEngineerCallout.render.parameters.source, commit: "unpinned" },
      },
    },
  })).toBe(false);
});

test("text broadcasts all clients while automatic voice routes to one stable client", () => {
  const manager = new WebSocketManager();
  const sent: string[][] = [[], []];
  const clients = sent.map((messages) => ({ data: { createdAt: 0, devTelemetrySubscribed: false }, send: (value: string) => { messages.push(value); }, close: () => {} }));
  clients.forEach((client) => manager.addClient(client as never));
  manager.broadcastNotification(raceEngineerCallout);
  manager.broadcastNotification(v3Voice);
  expect(sent[0]).toHaveLength(2);
  expect(sent[1]).toHaveLength(1);
});

test("accepts exact pace requests and delivery statuses only in protocol v3", () => {
  expect(isLiveEngineerVoiceRequestV3({ type: "live-engineer-voice-request", protocolVersion: 3, action: "exact-pace", requestId: "r", decisionId: "d" })).toBe(true);
  expect(isLiveEngineerVoiceRequestV3({ type: "live-engineer-voice-request", protocolVersion: 2, action: "exact-pace", requestId: "r", decisionId: "d" })).toBe(false);
  expect(isLiveEngineerDeliveryStatusV3({ type: "live-engineer-delivery-status", protocolVersion: 3, deliveryId: "d", status: "completed" })).toBe(true);
  expect(isLiveEngineerDeliveryStatusV3({ type: "live-engineer-delivery-status", protocolVersion: 2, deliveryId: "d", status: "completed" })).toBe(false);
});
