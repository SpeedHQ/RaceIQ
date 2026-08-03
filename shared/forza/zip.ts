import { readFileSync } from "node:fs";

export interface ZipEntry {
  name: string;
  compSize: number;
  uncompSize: number;
  dataStart: number;
}

export function parseForzaZip(
  zipPath: string
): { buf: Buffer; entries: ZipEntry[] } {
  const buf = Buffer.from(readFileSync(zipPath));
  const entries: ZipEntry[] = [];

  // Find End of Central Directory record (scan backwards)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return { buf, entries };

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdCount = buf.readUInt16LE(eocdOffset + 10);

  // Parse central directory entries
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50)
      break;

    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf
      .subarray(pos + 46, pos + 46 + nameLen)
      .toString("utf8");

    // Read local file header to get actual data start
    const lfhNameLen = buf.readUInt16LE(localOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;

    entries.push({ name, compSize, uncompSize, dataStart });

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return { buf, entries };
}
