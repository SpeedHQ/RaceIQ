import { describe, expect, test } from "bun:test";
import {
  encodeFrameLength,
  encodeMetaFrame,
  encodeSegmentContextEndFrame,
  encodeSegmentContextFrame,
} from "@raceiq/capture-formats/session/framing";
import { validateCloudImportCapture } from "../../session-capture/cloud-import-admission";

const selectors = { gameId: "fm-2023", lapIndex: 2, sessionKey: 7, sessionUID: "session-7" };
const frame = Buffer.from([1, 2, 3]);
const framed = Buffer.concat([encodeFrameLength(frame.length), frame]);
const valid = Buffer.concat([
  encodeMetaFrame(2),
  encodeSegmentContextFrame(), framed,
  encodeSegmentContextEndFrame(), framed,
]);

describe("cloud recording structural admission", () => {
  test("retains source frames outside explicit decoder context", () => {
    expect(validateCloudImportCapture(valid, selectors)).toEqual({ rawByteOffset: 51, rawFrameCount: 1 });
  });

  test("rejects unsupported version/header and truncated frames", () => {
    const badVersion = Buffer.from(valid);
    badVersion.writeUInt32LE(3, 4);
    expect(() => validateCloudImportCapture(badVersion, selectors)).toThrow("header");
    expect(() => validateCloudImportCapture(valid.subarray(0, valid.length - 1), selectors)).toThrow("record stream");
  });

  test("rejects selector indexes outside safe nonnegative bounds", () => {
    expect(() => validateCloudImportCapture(valid, { ...selectors, lapIndex: -1 })).toThrow("selectors");
    expect(() => validateCloudImportCapture(valid, { ...selectors, sessionKey: Number.MAX_SAFE_INTEGER + 1 })).toThrow("selectors");
  });

  test("rejects invalid context transitions and trailing bytes", () => {
    expect(() => validateCloudImportCapture(Buffer.concat([encodeMetaFrame(1), encodeSegmentContextEndFrame(), framed]), selectors))
      .toThrow("record stream");
    expect(() => validateCloudImportCapture(Buffer.concat([encodeMetaFrame(1), framed, Buffer.from([0])]), selectors))
      .toThrow("record stream");
  });

  test("rejects empty physical frame prefix before a hidden trailing segment", () => {
    const hiddenSegment = Buffer.concat([valid, encodeFrameLength(0), framed]);
    expect(() => validateCloudImportCapture(hiddenSegment, selectors)).toThrow("record stream");
  });
});
