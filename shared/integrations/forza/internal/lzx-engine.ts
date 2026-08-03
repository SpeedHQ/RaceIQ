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

const MIN_MATCH = 2;
const NUM_CHARS = 256;
const NUM_PRIMARY_LENGTHS = 7;
const NUM_SECONDARY_LENGTHS = 249;
const BLOCKTYPE_VERBATIM = 1;
const BLOCKTYPE_ALIGNED = 2;
const BLOCKTYPE_UNCOMPRESSED = 3;
const PRETREE_NUM_ELEMENTS = 20;
const PRETREE_MAXBITS = 6;
const MAINTREE_MAXBITS = 12;
const LENGTH_MAXBITS = 12;
const ALIGNED_NUM_ELEMENTS = 8;
const ALIGNED_MAXBITS = 7;
const extra_bits: number[] = [];
const position_base: number[] = [];
{
  let j = 0;
  for (let i = 0; i <= 50; i += 2) {
    extra_bits[i] = j;
    extra_bits[i + 1] = j;
    if (i !== 0 && j < 17) j++;
  }
}
{
  let j = 0;
  for (let i = 0; i <= 50; i++) {
    position_base[i] = j;
    j += 1 << extra_bits[i];
  }
}
export class BitReader {
  private _buf: Buffer;
  _offset: number; // byte offset into buffer
  _bitOffset: number; // bit offset within current 16-bit word (0-15)
  constructor(buf: Buffer) {
    this._buf = buf;
    this._offset = 0;
    this._bitOffset = 0;
  }
  private peek(n: number): Buffer {
    const end = Math.min(this._offset + n, this._buf.length);
    if (end - this._offset < n) {
      const r = Buffer.alloc(n, 0);
      this._buf.copy(r, 0, this._offset, end);
      return r;
    }
    return this._buf.subarray(this._offset, this._offset + n);
  }
  readLZXBits(bits: number): number {
    if (bits === 0) return 0;
    let bitsLeft = bits;
    let read = 0;
    while (bitsLeft > 0) {
      const peek = this.peek(2).readUInt16LE(0);
      const bitsInFrame = Math.min(bitsLeft, 16 - this._bitOffset);
      const offset = 16 - this._bitOffset - bitsInFrame;
      const value =
        (peek & (((1 << bitsInFrame) - 1) << offset)) >>> offset;
      bitsLeft -= bitsInFrame;
      this._bitOffset += bitsInFrame;
      if (this._bitOffset >= 16) {
        this._bitOffset -= 16;
        this._offset += 2;
      }
      read |= value << bitsLeft;
    }
    return read >>> 0;
  }
  peekLZXBits(bits: number): number {
    if (bits === 0) return 0;
    const savedOffset = this._offset;
    const savedBitOffset = this._bitOffset;
    const result = this.readLZXBits(bits);
    this._offset = savedOffset;
    this._bitOffset = savedBitOffset;
    return result;
  }
  readInt32(): number {
    const v = this._buf.readInt32LE(this._offset);
    this._offset += 4;
    return v;
  }
  align(): void {
    if (this._bitOffset > 0) {
      this.bitPosition += 16 - this._bitOffset;
    }
  }
  get bitPosition(): number {
    return this._bitOffset;
  }
  set bitPosition(offset: number) {
    if (offset < 0) offset = 16 - offset;
    this._bitOffset = offset % 16;
    this._offset +=
      Math.floor((offset - (Math.abs(offset) % 16)) / 16) * 2;
  }
}
function decodeTable( nsyms: number, nbits: number, lengths: number[] ): number[] {
  const table: number[] = [];
  let pos = 0;
  const tableMask = 1 << nbits;
  let bitMask = tableMask >> 1;
  for (let bitCount = 1; bitCount <= nbits; bitCount++) {
    for (let sym = 0; sym < nsyms; sym++) {
      if (lengths[sym] !== bitCount) continue;
      let leaf = pos;
      if ((pos += bitMask) > tableMask)
        throw new Error("Huffman table overrun!");
      let fill = bitMask;
      while (fill--) table[leaf++] = sym;
    }
    bitMask >>= 1;
  }
  if (pos === tableMask) return table;
  for (let sym = pos; sym < tableMask; sym++) table[sym] = 0xffff;
  let nextSym =
    (tableMask >> 1) < nsyms ? nsyms : tableMask >> 1;
  pos <<= 16;
  const tableMask16 = tableMask << 16;
  bitMask = 1 << 15;
  for (let bitCount = nbits + 1; bitCount <= 16; bitCount++) {
    for (let sym = 0; sym < nsyms; sym++) {
      if (lengths[sym] !== bitCount) continue;
      let leaf = pos >> 16;
      for (let fill = 0; fill < bitCount - nbits; fill++) {
        if (table[leaf] === 0xffff) {
          table[nextSym << 1] = 0xffff;
          table[(nextSym << 1) + 1] = 0xffff;
          table[leaf] = nextSym++;
        }
        leaf = table[leaf] << 1;
        if ((pos >>> (15 - fill)) & 1) leaf++;
      }
      table[leaf] = sym;
      if ((pos += bitMask) > tableMask16)
        throw new Error("Huffman table overrun!");
    }
    bitMask >>= 1;
  }
  return table;
}
function readHuffSymbol( reader: BitReader, table: number[], lengths: number[], nsyms: number, nbits: number ): number {
  const peeked32 = reader.peekLZXBits(32) >>> 0;
  let sym = table[reader.peekLZXBits(nbits)];
  if (sym >= nsyms) {
    let j = 1 << (32 - nbits);
    do {
      j >>= 1;
      sym <<= 1;
      sym |= peeked32 & j ? 1 : 0;
      if (!j) return 0;
    } while ((sym = table[sym]) >= nsyms);
  }
  reader.bitPosition += lengths[sym];
  return sym;
}
export class LzxDecoder {
  private windowSize: number;
  private win: number[];
  private windowPosn: number;
  private R0: number;
  private R1: number;
  private R2: number;
  private mainElements: number;
  headerRead: boolean;
  private blockRemaining: number;
  private blockType: number;
  private intelStarted: boolean;
  private intelFileSize: number;
  private intelCurPos: number;
  private maintreeLen: number[];
  private maintreeTable: number[];
  private lengthLen: number[];
  private lengthTable: number[];
  private alignedLen: number[];
  private alignedTable: number[];
  private pretreeLen: number[];
  private pretreeTable: number[];
  constructor(windowBits: number) {
    if (windowBits < 15 || windowBits > 21) {
      throw new Error(`Invalid window bits: ${windowBits}`);
    }
    this.windowSize = 1 << windowBits;
    this.win = new Array(this.windowSize).fill(0);
    this.windowPosn = 0;
    this.R0 = 1;
    this.R1 = 1;
    this.R2 = 1;
    const posnSlots =
      windowBits === 21 ? 50 : windowBits === 20 ? 42 : windowBits << 1;
    this.mainElements = NUM_CHARS + (posnSlots << 3);
    this.headerRead = false;
    this.blockRemaining = 0;
    this.blockType = 0;
    this.intelStarted = false;
    this.intelFileSize = 0;
    this.intelCurPos = 0;
    this.maintreeLen = new Array(NUM_CHARS + 50 * 8).fill(0);
    this.lengthLen = new Array(NUM_SECONDARY_LENGTHS).fill(0);
    this.alignedLen = [];
    this.pretreeLen = [];
    this.maintreeTable = [];
    this.lengthTable = [];
    this.alignedTable = [];
    this.pretreeTable = [];
  }
  decompress(reader: BitReader, frameSize: number): number[] {
    if (!this.headerRead) {
      const intel = reader.readLZXBits(1);
      if (intel) {
        const hi = reader.readLZXBits(16);
        const lo = reader.readLZXBits(16);
        this.intelFileSize = (hi << 16) | lo;
        this.intelStarted = true;
      }
      this.headerRead = true;
    }
    let togo = frameSize;
    while (togo > 0) {
      if (this.blockRemaining === 0) {
        this.blockType = reader.readLZXBits(3);
        const hi = reader.readLZXBits(16);
        const lo = reader.readLZXBits(8);
        this.blockRemaining = (hi << 8) | lo;
        switch (this.blockType) {
          // @ts-ignore — intentional fallthrough: ALIGNED initialises extra table then shares VERBATIM logic
          case BLOCKTYPE_ALIGNED:
            for (let i = 0; i < ALIGNED_NUM_ELEMENTS; i++) {
              this.alignedLen[i] = reader.readLZXBits(3);
            }
            this.alignedTable = decodeTable( ALIGNED_NUM_ELEMENTS, ALIGNED_MAXBITS, this.alignedLen );
          case BLOCKTYPE_VERBATIM:
            this.readLengths(reader, this.maintreeLen, 0, NUM_CHARS);
            this.readLengths( reader, this.maintreeLen, NUM_CHARS, this.mainElements );
            this.maintreeTable = decodeTable( NUM_CHARS + 50 * 8, MAINTREE_MAXBITS, this.maintreeLen );
            this.readLengths( reader, this.lengthLen, 0, NUM_SECONDARY_LENGTHS );
            this.lengthTable = decodeTable( NUM_SECONDARY_LENGTHS + 1, LENGTH_MAXBITS, this.lengthLen );
            break;
          case BLOCKTYPE_UNCOMPRESSED:
            reader.align();
            this.R0 = reader.readInt32();
            this.R1 = reader.readInt32();
            this.R2 = reader.readInt32();
            break;
          default:
            throw new Error(`Invalid block type: ${this.blockType}`);
        }
      }
      let thisRun: number;
      while ((thisRun = this.blockRemaining) > 0 && togo > 0) {
        if (thisRun > togo) thisRun = togo;
        togo -= thisRun;
        this.blockRemaining -= thisRun;
        this.windowPosn &= this.windowSize - 1;
        if ( this.blockType === BLOCKTYPE_VERBATIM || this.blockType === BLOCKTYPE_ALIGNED ) {
          this.decodeBlock( reader, thisRun, this.blockType === BLOCKTYPE_ALIGNED );
        } else if (this.blockType === BLOCKTYPE_UNCOMPRESSED) {
          for (let i = 0; i < thisRun; i++) {
            this.win[
              (this.windowPosn + i) & (this.windowSize - 1)
            ] = reader.readLZXBits(8);
          }
          this.windowPosn += thisRun;
        }
      }
    }
    const mask = this.windowSize - 1;
    const wp = this.windowPosn & mask;
    const start =
      (wp === 0 ? this.windowSize : wp) - frameSize;
    const result: number[] = [];
    for (let i = 0; i < frameSize; i++) {
      result.push( this.win[(start + this.windowSize + i) & mask] );
    }
    if (this.intelStarted && this.intelCurPos < this.intelFileSize) {
      const curPos = this.intelCurPos;
      const fileSize = this.intelFileSize;
      if (frameSize >= 10) {
        for (let i = 0; i < frameSize - 10; i++) {
          if (result[i] !== 0xe8) continue;
          const absTarget =
            result[i + 1] |
            (result[i + 2] << 8) |
            (result[i + 3] << 16) |
            (result[i + 4] << 24);
          const pos = curPos + i;
          if (absTarget >= -pos && absTarget < fileSize) {
            let relTarget: number;
            if (absTarget >= 0) {
              relTarget = absTarget - pos;
            } else {
              relTarget = absTarget + fileSize;
            }
            result[i + 1] = relTarget & 0xff;
            result[i + 2] = (relTarget >>> 8) & 0xff;
            result[i + 3] = (relTarget >>> 16) & 0xff;
            result[i + 4] = (relTarget >>> 24) & 0xff;
          }
          i += 4;
        }
      }
      this.intelCurPos += frameSize;
    }
    return result;
  }
  private decodeBlock( reader: BitReader, run: number, aligned: boolean ): void {
    const ws = this.windowSize;
    const wm = ws - 1;
    while (run > 0) {
      let me = readHuffSymbol( reader, this.maintreeTable, this.maintreeLen, NUM_CHARS + 50 * 8, MAINTREE_MAXBITS );
      if (me < NUM_CHARS) {
        this.win[this.windowPosn++ & wm] = me;
        run--;
        continue;
      }
      me -= NUM_CHARS;
      let matchLength = me & NUM_PRIMARY_LENGTHS;
      if (matchLength === NUM_PRIMARY_LENGTHS) {
        matchLength += readHuffSymbol( reader, this.lengthTable, this.lengthLen, NUM_SECONDARY_LENGTHS + 1, LENGTH_MAXBITS );
      }
      matchLength += MIN_MATCH;
      let matchOffset = me >> 3;
      if (matchOffset > 2) {
        if (aligned) {
          let eb = extra_bits[matchOffset];
          matchOffset = position_base[matchOffset] - 2;
          if (eb > 3) {
            eb -= 3;
            matchOffset += reader.readLZXBits(eb) << 3;
            matchOffset += readHuffSymbol( reader, this.alignedTable, this.alignedLen, ALIGNED_NUM_ELEMENTS, ALIGNED_MAXBITS );
          } else if (eb === 3) {
            matchOffset += readHuffSymbol( reader, this.alignedTable, this.alignedLen, ALIGNED_NUM_ELEMENTS, ALIGNED_MAXBITS );
          } else if (eb > 0) {
            matchOffset += reader.readLZXBits(eb);
          } else {
            matchOffset = 1;
          }
        } else {
          if (matchOffset !== 3) {
            matchOffset =
              position_base[matchOffset] -
              2 +
              reader.readLZXBits(extra_bits[matchOffset]);
          } else {
            matchOffset = 1;
          }
        }
        this.R2 = this.R1;
        this.R1 = this.R0;
        this.R0 = matchOffset;
      } else if (matchOffset === 0) {
        matchOffset = this.R0;
      } else if (matchOffset === 1) {
        matchOffset = this.R1;
        this.R1 = this.R0;
        this.R0 = matchOffset;
      } else {
        matchOffset = this.R2;
        this.R2 = this.R0;
        this.R0 = matchOffset;
      }
      let rd = this.windowPosn;
      let rs: number;
      run -= matchLength;
      if (this.windowPosn >= matchOffset) {
        rs = rd - matchOffset;
      } else {
        rs = rd + (ws - matchOffset);
        let copyLen = matchOffset - this.windowPosn;
        if (copyLen < matchLength) {
          matchLength -= copyLen;
          this.windowPosn += copyLen;
          while (copyLen-- > 0) {
            this.win[rd++ & wm] = this.win[rs++ & wm];
          }
          rs = 0;
        }
      }
      this.windowPosn += matchLength;
      while (matchLength-- > 0) {
        this.win[rd++ & wm] = this.win[rs++ & wm];
      }
    }
  }
  private readLengths( reader: BitReader, table: number[], first: number, last: number ): void {
    for (let i = 0; i < PRETREE_NUM_ELEMENTS; i++) {
      this.pretreeLen[i] = reader.readLZXBits(4);
    }
    this.pretreeTable = decodeTable( PRETREE_NUM_ELEMENTS, PRETREE_MAXBITS, this.pretreeLen );
    for (let i = first; i < last; ) {
      let sym = readHuffSymbol( reader, this.pretreeTable, this.pretreeLen, PRETREE_NUM_ELEMENTS, PRETREE_MAXBITS );
      if (sym === 17) {
        let zeros = reader.readLZXBits(4) + 4;
        while (zeros--) table[i++] = 0;
      } else if (sym === 18) {
        let zeros = reader.readLZXBits(5) + 20;
        while (zeros--) table[i++] = 0;
      } else if (sym === 19) {
        let same = reader.readLZXBits(1) + 4;
        sym = readHuffSymbol( reader, this.pretreeTable, this.pretreeLen, PRETREE_NUM_ELEMENTS, PRETREE_MAXBITS );
        sym = table[i] - sym;
        if (sym < 0) sym += 17;
        while (same--) table[i++] = sym;
      } else {
        sym = table[i] - sym;
        if (sym < 0) sym += 17;
        table[i++] = sym;
      }
    }
  }
}
