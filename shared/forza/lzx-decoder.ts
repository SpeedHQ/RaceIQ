/**
 * Forza LZX Decompressor
 *
 * Decompresses LZX-compressed data from Forza Motorsport ZIP files
 * (non-standard ZIP compression method 21).
 *
 * Ported from xnbcli by James Stine (Ms-PL), derived from MonoGame's
 * LzxDecoder by Ali Scissons (LGPL 2.1), itself from libmspack by Stuart Caie.
 *
 * Original LZX implementation:
 *   Copyright (C) Stuart Caie <kyzer@cabextract.org.uk>
 *   Licensed under LGPL 2.1
 *
 * MonoGame adaptation:
 *   Copyright (C) The MonoGame Team
 *   Licensed under Microsoft Public License (Ms-PL)
 */

import { BitReader, LzxDecoder } from "./internal/lzx-engine";

// ─── Public API ──────────────────────────────────────────────────────


export function decompressForzaLZX(
  compressed: Buffer,
  expectedSize: number,
): Buffer {
  let dataStart = 0;

  // Detect FF header for small files
  if (compressed[0] === 0xff) {
    const embeddedSize = compressed.readUInt16BE(1);
    if (embeddedSize === expectedSize) dataStart = 4;
  }

  const payload = compressed.subarray(dataStart);

  // Try multiple approaches — the format varies between files
  for (const wb of [16, 17, 15]) {
    // Approach 0a: XMem 2-byte header blocks with concatenated stream
    // Strips block headers, uses single reader with chunk-boundary alignment.
    try {
      const result = decompressXMem2ByteHeadersConcatenated(payload, expectedSize, wb);
      if (result.length === expectedSize) return result;
    } catch {}

    // Approach 0b: XMem 2-byte header blocks with persistent decoder
    // (delta-encoded Huffman tables shared across blocks)
    try {
      const result = decompressXMem2ByteHeaders(payload, expectedSize, wb);
      if (result.length >= expectedSize * 0.5) return result;
    } catch {}

    // Approach 1a: XMem block framing with independent decoders
    try {
      const result = decompressXMemBlocks(payload, expectedSize, wb, false);
      if (result.length === expectedSize) return result;
    } catch {}

    // Approach 1b: XMem block framing with persistent decoder state
    try {
      const result = decompressXMemBlocks(payload, expectedSize, wb, true);
      if (result.length === expectedSize) return result;
    } catch {}

    // Approach 2: Single LZX stream
    try {
      const reader = new BitReader(payload);
      const decoder = new LzxDecoder(wb);
      const result = decoder.decompress(reader, expectedSize);
      return Buffer.from(result);
    } catch {}

    // Approach 3: Skip different header sizes
    for (const skip of [2, 3, 5, 6, 8]) {
      if (skip >= compressed.length) continue;
      try {
        const reader = new BitReader(compressed.subarray(skip));
        const decoder = new LzxDecoder(wb);
        const result = decoder.decompress(reader, expectedSize);
        return Buffer.from(result);
      } catch {}
    }
  }

  // Approach 4: XMem with skip + persistent decoder
  for (const skip of [2, 4]) {
    for (const wb of [17, 16, 15]) {
      try {
        const result = decompressXMemBlocks(
          compressed.subarray(skip), expectedSize, wb, true,
        );
        if (result.length === expectedSize) return result;
      } catch {}
    }
  }

  // Last resort: multi-frame for large files - try many combinations
  // of skip bytes, window bits, and frame sizes, keeping the best result
  let bestResult: Buffer | null = null;
  let bestLen = 0;

  for (const skip of [0, 2, 4, 6]) {
    if (skip >= compressed.length) continue;
    for (const wb of [15, 16, 17, 18]) {
      for (const frameSz of [0x8000, 0x4000, 0x2000]) {
        const stream = compressed.subarray(skip);
        const reader = new BitReader(stream);
        let decoder: LzxDecoder;
        try {
          decoder = new LzxDecoder(wb);
        } catch {
          continue;
        }
        const output = Buffer.alloc(expectedSize);
        let pos = 0;
        let remaining = expectedSize;
        while (remaining > 0) {
          const thisFrame = Math.min(frameSz, remaining);
          try {
            const frame = decoder.decompress(reader, thisFrame);
            for (let i = 0; i < frame.length; i++) output[pos + i] = frame[i];
            pos += thisFrame;
            remaining -= thisFrame;
          } catch {
            break;
          }
        }
        if (pos > bestLen) {
          bestLen = pos;
          bestResult = output.subarray(0, pos);
        }
        if (pos === expectedSize) return bestResult!;
      }
    }
  }

  if (bestResult && bestLen >= expectedSize * 0.1) return bestResult;

  throw new Error(
    `LZX decompression failed for ${compressed.length} bytes → ${expectedSize} expected`,
  );
}

function decompressXMemBlocks(
  data: Buffer,
  expectedSize: number,
  windowBits: number,
  persistDecoder = false,
): Buffer {
  const output = Buffer.alloc(expectedSize);
  let outPos = 0;
  let offset = 0;
  const sharedDecoder = persistDecoder ? new LzxDecoder(windowBits) : null;
  while (offset < data.length - 4 && outPos < expectedSize) {
    const compBlockSize = data.readUInt16BE(offset);
    const uncompBlockSize = data.readUInt16BE(offset + 2);
    offset += 4;
    if (compBlockSize === 0 || uncompBlockSize === 0) break;
    if (offset + compBlockSize > data.length) break;
    const blockData = data.subarray(offset, offset + compBlockSize);
    const reader = new BitReader(blockData);
    const decoder = sharedDecoder ?? new LzxDecoder(windowBits);
    const result = decoder.decompress(reader, uncompBlockSize);
    for (let i = 0; i < result.length && outPos < expectedSize; i++)
      output[outPos++] = result[i];
    offset += compBlockSize;
  }
  return output.subarray(0, outPos);
}

/**
 * Validates that data uses 2-byte header block framing:
 * - Blocks consume nearly all input (>= 95%)
 * - Expected output (blockCount * 32KB) is close to expectedSize (within 5%)
 * - All blocks are reasonably sized (>= 256 bytes)
 * - Supports 0xFF last-block marker: FF [uncompSize:2 BE] [compSize:2 BE]
 */
// @ts-ignore — utility function reserved for future validation
function _isValid2ByteHeaderFraming(data: Buffer, expectedSize: number): boolean {
  const BLOCK_OUTPUT = 0x8000;
  let scanOffset = 0;
  let blockCount = 0;
  let minBlockSize = Infinity;
  let totalOutput = 0;
  while (scanOffset < data.length) {
    if (data[scanOffset] === 0xff && scanOffset + 5 <= data.length) {
      // Last block marker: FF [uncompSize:2 BE] [compSize:2 BE]
      const lastUncomp = data.readUInt16BE(scanOffset + 1);
      const lastComp = data.readUInt16BE(scanOffset + 3);
      scanOffset += 5;
      if (scanOffset + lastComp > data.length) break;
      scanOffset += lastComp;
      totalOutput += lastUncomp;
      blockCount++;
      break;
    }
    if (scanOffset + 2 > data.length) break;
    const sz = data.readUInt16BE(scanOffset);
    scanOffset += 2;
    if (sz === 0) break;
    if (scanOffset + sz > data.length) break;
    if (sz < minBlockSize) minBlockSize = sz;
    scanOffset += sz;
    totalOutput += BLOCK_OUTPUT;
    blockCount++;
  }
  if (blockCount < 2 || minBlockSize < 256) return false;
  if (scanOffset < data.length * 0.95) return false;
  const ratio = expectedSize / totalOutput;
  return ratio >= 0.95 && ratio <= 1.05;
}

/**
 * XMem LZX decompression with 2-byte block headers.
 * Format: [2B BE compressed_block_size] [LZX data] repeated.
 * Last block uses 0xFF marker: FF [uncompSize:2 BE] [compSize:2 BE].
 * Each block decompresses to 32KB (0x8000) except the last which is smaller.
 *
 * Key insight: blocks share decoder state (delta-encoded Huffman tables,
 * R0/R1/R2 repeat offsets, sliding window). A single persistent LzxDecoder
 * is reused across all blocks, with a fresh padded BitReader per block.
 * Intel header is only read for block 0.
 */
function decompressXMem2ByteHeaders(
  data: Buffer,
  expectedSize: number,
  windowBits: number,
): Buffer {
  const BLOCK_OUTPUT = 0x8000; // 32KB per block
  const FRAME_SIZE = 0x1000;   // 4KB sub-frames for last-block recovery
  const PADDING = 16;           // Zero-byte padding for BitReader peek-ahead
  const output = Buffer.alloc(expectedSize);
  let outPos = 0;
  let offset = 0;
  const decoder = new LzxDecoder(windowBits);
  let blockIndex = 0;
  while (offset < data.length - 1 && outPos < expectedSize) {
    let compBlockSize: number;
    let uncompBlockSize: number;

    // Check for 0xFF last-block marker: FF [uncompSize:2 BE] [compSize:2 BE]
    if (data[offset] === 0xff && offset + 5 <= data.length) {
      uncompBlockSize = data.readUInt16BE(offset + 1);
      compBlockSize = data.readUInt16BE(offset + 3);
      offset += 5;
    } else {
      compBlockSize = data.readUInt16BE(offset);
      offset += 2;
      const remaining = expectedSize - outPos;
      uncompBlockSize = Math.min(BLOCK_OUTPUT, remaining);
    }

    if (compBlockSize === 0) break;
    const actualCompSize = Math.min(compBlockSize, data.length - offset);
    if (actualCompSize <= 0) break;
    // Pad block data with zeros so BitReader peek-ahead doesn't read garbage
    const padded = Buffer.alloc(actualCompSize + PADDING, 0);
    data.copy(padded, 0, offset, offset + actualCompSize);
    const reader = new BitReader(padded);
    if (blockIndex > 0) decoder.headerRead = true;

    // Last block (declared size > available) — use sub-frames for partial recovery
    if (compBlockSize > actualCompSize) {
      let blockOut = 0;
      while (blockOut < uncompBlockSize) {
        const frameSz = Math.min(FRAME_SIZE, uncompBlockSize - blockOut);
        try {
          const frame = decoder.decompress(reader, frameSz);
          for (let i = 0; i < frame.length && outPos < expectedSize; i++)
            output[outPos++] = frame[i];
          blockOut += frameSz;
        } catch { break; }
      }
      break; // Last block — done
    }

    try {
      const result = decoder.decompress(reader, uncompBlockSize);
      for (let i = 0; i < result.length && outPos < expectedSize; i++)
        output[outPos++] = result[i];
    } catch {
      break;
    }

    offset += actualCompSize;
    blockIndex++;
  }
  return output.subarray(0, outPos);
}

/**
 * XMem LZX decompression with 2-byte block headers and concatenated stream.
 * Strips block headers, concatenates compressed data, and uses a single
 * BitReader + LzxDecoder. The LZX block structure spans transport chunks;
 * blockRemaining carries over between chunks. The bit reader is realigned
 * to each chunk boundary between frames.
 * Supports 0xFF last-block marker: FF [uncompSize:2 BE] [compSize:2 BE].
 */
function decompressXMem2ByteHeadersConcatenated(
  data: Buffer,
  expectedSize: number,
  windowBits: number,
): Buffer {
  const BLOCK_OUTPUT = 0x8000;

  // Phase 1: Parse block headers and compute frame sizes
  const chunks: Buffer[] = [];
  const frameSizes: number[] = [];
  let scanOffset = 0;

  while (scanOffset < data.length) {
    if (data[scanOffset] === 0xff && scanOffset + 5 <= data.length) {
      const lastUncomp = data.readUInt16BE(scanOffset + 1);
      const lastComp = data.readUInt16BE(scanOffset + 3);
      scanOffset += 5;
      if (scanOffset + lastComp > data.length) break;
      chunks.push(data.subarray(scanOffset, scanOffset + lastComp));
      frameSizes.push(lastUncomp);
      scanOffset += lastComp;
      break;
    }
    if (scanOffset + 2 > data.length) break;
    const compSize = data.readUInt16BE(scanOffset);
    scanOffset += 2;
    if (compSize === 0) break;
    if (scanOffset + compSize > data.length) break;
    chunks.push(data.subarray(scanOffset, scanOffset + compSize));
    frameSizes.push(BLOCK_OUTPUT);
    scanOffset += compSize;
  }

  if (chunks.length === 0) throw new Error("No blocks found");

  // Include any trailing bytes after the last block as padding
  // (the LZX bit reader may need a few extra bytes for lookahead)
  if (scanOffset < data.length) {
    chunks.push(data.subarray(scanOffset));
  }

  // Phase 2: Concatenate compressed data
  const totalComp = chunks.reduce((s, c) => s + c.length, 0);
  const concat = Buffer.alloc(totalComp);
  let pos = 0;
  const chunkOffsets: number[] = [];
  for (const chunk of chunks) {
    chunkOffsets.push(pos);
    chunk.copy(concat, pos);
    pos += chunk.length;
  }

  // Phase 3: Decompress with a single reader, realigning to chunk boundaries
  const reader = new BitReader(concat);
  const decoder = new LzxDecoder(windowBits);
  const output = Buffer.alloc(expectedSize);
  let outPos = 0;

  for (let i = 0; i < frameSizes.length; i++) {
    const frameSize = frameSizes[i];

    if (i > 0) {
      reader._offset = chunkOffsets[i];
      reader._bitOffset = 0;
      // Do NOT reset block state -- LZX blocks span transport chunks.
      // blockRemaining carries over from the previous chunk.
    }

    const frame = decoder.decompress(reader, frameSize);
    for (let j = 0; j < frame.length && outPos < expectedSize; j++) {
      output[outPos++] = frame[j];
    }
  }

  return output.subarray(0, outPos);
}
