import {
  iterateSessionCaptureRecords,
  META_FRAME_MAGIC,
  readFramePrefix,
  readFrameStreamStart,
} from "@raceiq/capture-formats/session/framing";

export interface CloudImportCaptureSelectors {
  gameId: string;
  lapIndex: number;
  sessionKey: number;
  sessionUID: string | null;
}

/** Validate raceiq-session v1 framing and retain non-context source frames. */
export function validateCloudImportCapture(
  capture: Buffer,
  selectors: CloudImportCaptureSelectors,
): { rawByteOffset: number; rawFrameCount: number } {
  if (!Buffer.isBuffer(capture) || capture.length < 12 ||
      capture.readUInt32LE(0) !== META_FRAME_MAGIC || capture.readUInt32LE(4) !== 4) {
    throw new Error("Invalid raceiq-session v1 header");
  }
  if (!selectors || typeof selectors.gameId !== "string" || selectors.gameId.length === 0 ||
      !Number.isSafeInteger(selectors.lapIndex) || selectors.lapIndex < 0 ||
      !Number.isSafeInteger(selectors.sessionKey) || selectors.sessionKey < 0 ||
      (selectors.sessionUID !== null && typeof selectors.sessionUID !== "string")) {
    throw new Error("Invalid cloud import selectors");
  }

  const declaredFrameCount = capture.readUInt32LE(8);
  let rawFrameCount = 0;
  let rawByteOffset = -1;
  let frameCount = 0;
  let contextOpen = false;
  let contextEnded = false;
  let sawRecord = false;
  let offset = 12;

  try {
    for (const record of iterateSessionCaptureRecords(capture, readFrameStreamStart(capture))) {
      sawRecord = true;
      if (record.kind === "segment-context") {
        if (contextOpen || contextEnded || rawFrameCount > 0) throw new Error("Invalid segment-context transition");
        contextOpen = true;
        continue;
      }
      if (record.kind === "segment-context-end") {
        if (!contextOpen || contextEnded) throw new Error("Invalid segment-context-end transition");
        contextOpen = false;
        contextEnded = true;
        continue;
      }
      if (record.kind === "segment-boundary") {
        if (contextOpen || rawFrameCount > 0) throw new Error("Multiple source segments are not addressable by cloud manifest");
        continue;
      }
      frameCount++;
      if (!contextOpen) {
        if (rawByteOffset < 0) rawByteOffset = record.offset;
        rawFrameCount++;
      }
    }

    while (offset < capture.length) {
      if (offset + 4 > capture.length) throw new Error("Trailing bytes in capture");
      if (capture.readUInt32LE(offset) === META_FRAME_MAGIC) {
        if (offset + 8 > capture.length) throw new Error("Truncated metadata record");
        const length = capture.readUInt32LE(offset + 4);
        if (length !== 8 || offset + 16 > capture.length) throw new Error("Invalid metadata length");
        const magic = capture.readUInt32LE(offset + 8);
        const version = capture.readUInt32LE(offset + 12);
        if (!((magic === 0x4d474553 || magic === 0x58544753 || magic === 0x454e4353) && version === 1)) {
          throw new Error("Unsupported metadata marker");
        }
        offset += 16;
      } else {
        const prefix = readFramePrefix(capture, offset);
        if (!prefix || prefix.length === 0 || offset + prefix.prefixBytes + prefix.length > capture.length) throw new Error("Truncated frame");
        offset += prefix.prefixBytes + prefix.length;
      }
    }
  } catch (error) {
    throw new Error("Invalid raceiq-session v1 record stream", { cause: error });
  }

  if (!sawRecord || contextOpen || rawFrameCount === 0) throw new Error("Invalid raceiq-session segment context");
  if (declaredFrameCount !== 0 && declaredFrameCount !== frameCount) {
    throw new Error("raceiq-session frame count does not match header");
  }
  return { rawByteOffset, rawFrameCount };
}
