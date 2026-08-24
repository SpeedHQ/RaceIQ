import { expect, test } from "bun:test";
import type { SpotterCalloutMessageV2 } from "../../shared/racing/live/engineer-contracts";
import { useLiveEngineerStore } from "../src/stores/live-engineer";

const callout = (decisionId: string, sourceSequence: number): SpotterCalloutMessageV2 => ({
  type: "live-engineer-callout",
  protocolVersion: 2,
  family: "spotter",
  decisionId,
  candidateId: `candidate-${decisionId}`,
  sessionId: "s",
  timelineEpoch: 1,
  sourceSequence,
  priority: "high",
  createdSessionTimeMs: sourceSequence,
  expiresSessionTimeMs: sourceSequence + 2_000,
  render: { renderingVersion: "spotter-v1", textKey: "live_engineer_spotter_car_left", parameters: { state: "car-left", side: "left", overlapCount: 1 } },
});

test("dismisses each callout once while keeping bounded history separate", () => {
  const store = useLiveEngineerStore.getState();
  store.receiveCallout(callout("a", 1));
  store.receiveCallout(callout("b", 2));
  expect(useLiveEngineerStore.getState().current?.decisionId).toBe("a");
  expect(useLiveEngineerStore.getState().queue.map((item) => item.decisionId)).toEqual(["b"]);
  store.dismiss();
  expect(useLiveEngineerStore.getState().current?.decisionId).toBe("b");
  store.dismiss();
  expect(useLiveEngineerStore.getState().current).toBeNull();
  expect(useLiveEngineerStore.getState().history.map((item) => item.decisionId)).toEqual(["b", "a"]);
});

test("bounds visible history and tracks outbound controls", () => {
  const store = useLiveEngineerStore.getState();
  for (let i = 0; i < 7; i += 1) store.receiveCallout(callout(`d${i}`, i));
  expect(useLiveEngineerStore.getState().history).toHaveLength(5);
  store.enqueueControl({ type: "live-engineer-delivery-status", protocolVersion: 2, deliveryId: "d4", status: "started" });
  expect(store.takeOutbound()?.type).toBe("live-engineer-delivery-status");
});
