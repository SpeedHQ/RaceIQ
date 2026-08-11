/**
 * Read-only parser for AC Evo `content.kspkg` (Kunos Package) archives.
 *
 * Format (reverse-engineered; see github.com/ntpopgetdope/ace-kspkg and
 * Nenkai/ACEvo.Package):
 *   - File table lives in the LAST N bytes of the archive.
 *     N is 0x4_000_000 (64 MiB, game >= 0.7) or 0x2_000_000 (32 MiB, < 0.7).
 *   - Table is obfuscated with a repeating 8-byte XOR key
 *     (0x9F9721A97D1135C1, applied little-endian).
 *   - Entries are 0x100 bytes each, terminated by an entry whose FNV1a-64
 *     path hash is 0:
 *       +0x00  char[0xE0] filePath (ASCII, backslash separators)
 *       +0xE0  int32      align/unused
 *       +0xE4  int16      flags (bit0 = directory, bit8 = per-file XOR cipher)
 *       +0xE6  int16      pathLength
 *       +0xE8  uint64     FNV1a-64 of casefolded path (lookup key)
 *       +0xF0  int64      fileSize
 *       +0xF8  int64      fileOffset (absolute, from archive start)
 */
import { openSync, readSync, closeSync, fstatSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Candidate Steam library roots checked by findContentKspkg(). */
const STEAM_ROOTS = [
  "C:\\Program Files (x86)\\Steam\\steamapps\\common",
  "C:\\SteamLibrary\\steamapps\\common",
  "D:\\SteamLibrary\\steamapps\\common",
  "E:\\SteamLibrary\\steamapps\\common",
];

/**
 * Locate content.kspkg. Order: explicit argument, AC_EVO_KSPKG env var,
 * then common Steam library roots. Returns null if not found.
 */
export function findContentKspkg(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.AC_EVO_KSPKG,
    ...STEAM_ROOTS.map((r) => join(r, "Assetto Corsa EVO", "content.kspkg")),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

const ENTRY_SIZE = 0x100;
const PATH_SIZE = 0xe0;
const TABLE_SIZES = [0x4_000_000, 0x2_000_000];
/** Repeating 8-byte XOR key, little-endian bytes of 0x9F9721A97D1135C1. */
const XOR_KEY = Buffer.from([0xc1, 0x35, 0x11, 0x7d, 0xa9, 0x21, 0x97, 0x9f]);

export const FLAG_DIRECTORY = 1 << 0;
export const FLAG_XOR_CIPHER = 1 << 8;

export interface KspkgEntry {
  path: string;
  flags: number;
  isDirectory: boolean;
  size: number;
  offset: number;
  pathHash: bigint;
}

function xorInPlace(buf: Buffer): Buffer {
  for (let i = 0; i < buf.length; i++) buf[i] ^= XOR_KEY[i % 8];
  return buf;
}

/** FNV1a-64 over UTF-16LE bytes of the casefolded, backslash-normalised path (table lookup key). */
export function kspkgPathHash(path: string): bigint {
  const data = Buffer.from(path.toLowerCase().replace(/\//g, "\\"), "utf16le");
  let h = 0xcbf29ce484222325n;
  for (const b of data) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}

function parseEntry(buf: Buffer, off: number): KspkgEntry | null {
  const pathHash = buf.readBigUInt64LE(off + 0xe8);
  if (pathHash === 0n) return null; // table terminator
  const flags = buf.readInt16LE(off + 0xe4);
  const pathLen = buf.readInt16LE(off + 0xe6);
  if (pathLen <= 0 || pathLen > PATH_SIZE) return null;
  return {
    path: buf.toString("ascii", off, off + pathLen),
    flags,
    isDirectory: (flags & FLAG_DIRECTORY) !== 0,
    size: Number(buf.readBigInt64LE(off + 0xf0)),
    offset: Number(buf.readBigInt64LE(off + 0xf8)),
    pathHash,
  };
}

export class Kspkg {
  private fd: number;
  private fileSize: number;
  readonly entries: KspkgEntry[] = [];
  private byHash = new Map<bigint, KspkgEntry>();

  private constructor(fd: number, fileSize: number) {
    this.fd = fd;
    this.fileSize = fileSize;
  }

  static open(kspkgPath: string): Kspkg {
    const fd = openSync(kspkgPath, "r");
    const size = fstatSync(fd).size;
    const pkg = new Kspkg(fd, size);
    try {
      pkg.parseFileTable();
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    return pkg;
  }

  private readAt(offset: number, length: number): Buffer {
    const buf = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, buf, done, length - done, offset + done);
      if (n === 0) throw new Error(`unexpected EOF at ${offset + done}`);
      done += n;
    }
    return buf;
  }

  /** Probe known table sizes; first whose leading entry decodes sanely wins. */
  private detectTableSize(): number {
    for (const tableSize of TABLE_SIZES) {
      if (tableSize >= this.fileSize) continue;
      const probe = xorInPlace(this.readAt(this.fileSize - tableSize, ENTRY_SIZE));
      const entry = parseEntry(probe, 0);
      if (entry && /^[\x20-\x7e]+$/.test(entry.path)) return tableSize;
    }
    throw new Error("could not detect kspkg file table (not a content.kspkg?)");
  }

  private parseFileTable(): void {
    const tableSize = this.detectTableSize();
    const table = xorInPlace(this.readAt(this.fileSize - tableSize, tableSize));
    for (let off = 0; off + ENTRY_SIZE <= tableSize; off += ENTRY_SIZE) {
      const entry = parseEntry(table, off);
      if (!entry) break;
      this.entries.push(entry);
      this.byHash.set(entry.pathHash, entry);
    }
  }

  find(path: string): KspkgEntry | undefined {
    return this.byHash.get(kspkgPathHash(path));
  }

  /** Read a (non-directory) entry's contents, de-ciphering if needed. */
  readFile(entry: KspkgEntry | string): Buffer {
    const e = typeof entry === "string" ? this.find(entry) : entry;
    if (!e) throw new Error(`kspkg entry not found: ${String(entry)}`);
    if (e.isDirectory) throw new Error(`kspkg entry is a directory: ${e.path}`);
    const data = this.readAt(e.offset, e.size);
    return (e.flags & FLAG_XOR_CIPHER) !== 0 ? xorInPlace(data) : data;
  }

  close(): void {
    closeSync(this.fd);
  }
}
