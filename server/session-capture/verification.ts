import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ArchiveVerification } from "../../shared/racing/quality/contracts";
import { META_FRAME_BYTES, META_FRAME_MAGIC } from "./framing";

const VERIFICATION_CHUNK_BYTES = 64 * 1024;

export interface SessionCaptureVerificationExpectations {
  expectedBytes: number;
  expectedFrameCount: number;
  hasMetadata: boolean;
  expectedRecordGeneration: string;
}

type VerificationFailure = Pick<ArchiveVerification, "state" | "details">;
type ParserStage = "metadata" | "prefix" | "payload";

export async function verifySessionCaptureFile(
  path: string,
  expectations: SessionCaptureVerificationExpectations,
): Promise<ArchiveVerification> {
  const fileHasher = createHash("sha256");
  const recordHasher = createHash("sha256");
  const metadata = Buffer.allocUnsafe(META_FRAME_BYTES);
  const prefix = Buffer.allocUnsafe(4);
  let stage: ParserStage = expectations.hasMetadata ? "metadata" : "prefix";
  let metadataBytes = 0;
  let prefixBytes = 0;
  let payloadBytesRemaining = 0;
  let parsedBytes = 0;
  let actualBytes = 0;
  let actualFrameCount = 0;
  let recordOffset = expectations.hasMetadata ? META_FRAME_BYTES : 0;
  let parserFailure: VerificationFailure | null = null;

  const consume = (chunk: Buffer): void => {
    if (parserFailure) return;
    let offset = 0;
    while (offset < chunk.length && !parserFailure) {
      if (stage === "metadata") {
        const count = Math.min(META_FRAME_BYTES - metadataBytes, chunk.length - offset);
        chunk.copy(metadata, metadataBytes, offset, offset + count);
        metadataBytes += count;
        parsedBytes += count;
        offset += count;
        if (metadataBytes === META_FRAME_BYTES) {
          if (
            metadata.readUInt32LE(0) !== META_FRAME_MAGIC ||
            metadata.readUInt32LE(4) !== META_FRAME_BYTES - 8 ||
            metadata.readUInt32LE(8) !== expectations.expectedFrameCount
          ) {
            parserFailure = {
              state: "corrupt",
              details: "Recording metadata frame does not match written frame count",
            };
          } else {
            stage = "prefix";
          }
        }
        continue;
      }

      if (stage === "prefix") {
        if (prefixBytes === 0) recordOffset = parsedBytes;
        const count = Math.min(4 - prefixBytes, chunk.length - offset);
        chunk.copy(prefix, prefixBytes, offset, offset + count);
        prefixBytes += count;
        parsedBytes += count;
        offset += count;
        if (prefixBytes === 4) {
          const payloadLength = prefix.readUInt32LE(0);
          recordHasher.update(prefix);
          prefixBytes = 0;
          if (payloadLength === 0) {
            parserFailure = {
              state: "corrupt",
              details: `Empty frame at byte ${recordOffset}`,
            };
          } else {
            payloadBytesRemaining = payloadLength;
            stage = "payload";
          }
        }
        continue;
      }

      const count = Math.min(payloadBytesRemaining, chunk.length - offset);
      recordHasher.update(chunk.subarray(offset, offset + count));
      payloadBytesRemaining -= count;
      parsedBytes += count;
      offset += count;
      if (payloadBytesRemaining === 0) {
        actualFrameCount++;
        stage = "prefix";
      }
    }
  };

  const getParserFailure = (): VerificationFailure | null => parserFailure;
  const getParserStage = (): ParserStage => stage;

  try {
    const stream = createReadStream(path, { highWaterMark: VERIFICATION_CHUNK_BYTES });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      actualBytes += bytes.length;
      fileHasher.update(bytes);
      consume(bytes);
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : null;
    if (code === "ENOENT") {
      return {
        state: "unavailable",
        sourceGeneration: null,
        details: "Recording file disappeared before verification",
      };
    }
    return {
      state: "corrupt",
      sourceGeneration: null,
      details: error instanceof Error ? error.message : String(error),
    };
  }

  const sourceGeneration = `sha256:${fileHasher.digest("hex")}`;
  if (actualBytes < expectations.expectedBytes) {
    return {
      state: "truncated",
      sourceGeneration,
      details: `Expected ${expectations.expectedBytes} bytes, found ${actualBytes}`,
    };
  }
  if (actualBytes > expectations.expectedBytes) {
    return {
      state: "corrupt",
      sourceGeneration,
      details: `Expected ${expectations.expectedBytes} bytes, found ${actualBytes}`,
    };
  }
  const failure = getParserFailure();
  if (failure) {
    return { state: failure.state, sourceGeneration, details: failure.details };
  }
  const finalStage = getParserStage();
  if (finalStage === "metadata") {
    return {
      state: "truncated",
      sourceGeneration,
      details: metadataBytes < 8
        ? "Truncated recorder metadata header at byte 0"
        : "Truncated recorder metadata payload at byte 0",
    };
  }
  if (finalStage === "prefix" && prefixBytes > 0) {
    return {
      state: "truncated",
      sourceGeneration,
      details: `Truncated frame length at byte ${recordOffset}`,
    };
  }
  if (finalStage === "payload") {
    return {
      state: "truncated",
      sourceGeneration,
      details: `Truncated frame payload at byte ${recordOffset}`,
    };
  }
  if (actualFrameCount !== expectations.expectedFrameCount) {
    return {
      state: "corrupt",
      sourceGeneration,
      details: `Expected ${expectations.expectedFrameCount} frames, found ${actualFrameCount}`,
    };
  }
  if (`sha256:${recordHasher.digest("hex")}` !== expectations.expectedRecordGeneration) {
    return {
      state: "corrupt",
      sourceGeneration,
      details: "Recording digest does not match written frames",
    };
  }
  return { state: "verified", sourceGeneration };
}
