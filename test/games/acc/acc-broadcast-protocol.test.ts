import { describe, expect, test } from "bun:test";
import {
  ACC_BROADCAST_PROTOCOL_VERSION,
  encodeAccBroadcastRegistration,
  parseAccBroadcastMessage,
} from "../../../server/games/acc/broadcast-protocol";

describe("ACC Broadcasting Network Protocol", () => {
  test("encodes protocol v4 registration in source wire order", () => {
    const bytes = encodeAccBroadcastRegistration("RaceIQ", "", 100, "");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint8(0)).toBe(1);
    expect(view.getUint8(1)).toBe(ACC_BROADCAST_PROTOCOL_VERSION);
    expect(view.getUint16(2, true)).toBe(6);
    expect(new TextDecoder().decode(bytes.slice(4, 10))).toBe("RaceIQ");
  });

  test("decodes realtime car update", () => {
    const bytes = new Uint8Array(128);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    view.setUint8(offset++, 3);
    view.setUint16(offset, 7, true); offset += 2;
    view.setUint16(offset, 2, true); offset += 2;
    view.setUint8(offset++, 1);
    view.setUint8(offset++, 4);
    view.setFloat32(offset, 10.5, true); offset += 4;
    view.setFloat32(offset, 1.25, true); offset += 4;
    view.setFloat32(offset, -4.5, true); offset += 4;
    view.setUint8(offset++, 1);
    view.setUint16(offset, 123, true); offset += 2;
    view.setUint16(offset, 4, true); offset += 2;
    view.setUint16(offset, 3, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setFloat32(offset, 0.75, true); offset += 4;
    view.setUint16(offset, 5, true); offset += 2;
    view.setInt32(offset, -12, true); offset += 4;
    for (const value of [91_234, 91_500, 92_000]) { view.setInt32(offset, value, true); offset += 4; view.setUint16(offset, 7, true); offset += 2; view.setUint16(offset, 2, true); offset += 2; view.setUint8(offset++, 0); view.setUint8(offset++, 0); view.setUint8(offset++, 0); view.setUint8(offset++, 0); view.setUint8(offset++, 0); }
    const message = parseAccBroadcastMessage(bytes);
    expect(message).toMatchObject({ type: "realtime-car-update", carIndex: 7, worldPosX: 10.5, worldPosY: 1.25, yaw: -4.5, kmh: 123, laps: 5, lastLapTimeMs: 91_500, lastLapValid: true });
  });

  test("rejects truncated and unknown messages", () => {
    expect(parseAccBroadcastMessage(new Uint8Array([3, 1]))).toBeNull();
    expect(parseAccBroadcastMessage(new Uint8Array([255]))).toBeNull();
  });
});
