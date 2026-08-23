import { expect, test } from "bun:test";
import { isLiveEngineerVoiceRequestV2, isLiveEngineerDeliveryStatusV2 } from "../../shared/racing/live/engineer-contracts";

test("accepts exact pace requests and delivery statuses only in protocol v2", () => {
  expect(isLiveEngineerVoiceRequestV2({ type: "live-engineer-voice-request", protocolVersion: 2, action: "exact-pace", requestId: "r", decisionId: "d" })).toBe(true);
  expect(isLiveEngineerVoiceRequestV2({ type: "live-engineer-voice-request", protocolVersion: 1, action: "exact-pace", requestId: "r", decisionId: "d" })).toBe(false);
  expect(isLiveEngineerDeliveryStatusV2({ type: "live-engineer-delivery-status", protocolVersion: 2, deliveryId: "d", status: "completed" })).toBe(true);
});
