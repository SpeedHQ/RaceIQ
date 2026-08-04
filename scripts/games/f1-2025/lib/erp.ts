export const ERP_MAGIC = 0x4b505245;

export interface ErpHeader {
  magic: number;
  version: number;
  resourceOffset: bigint;
  numFiles: number;
  numTempFiles: number;
}

export interface ErpFragment {
  name: string;
  offset: bigint;
  size: bigint;
  flags: number;
  compression: number;
  packedSize: bigint;
}

export interface ErpResource {
  identifier: string;
  resourceType: string;
  unknown: number;
  unknown2: number;
  fragmentCount: number;
  fragments: ErpFragment[];
  hash: Uint8Array;
}

export interface ErpFile {
  header: ErpHeader;
  resources: ErpResource[];
}

/** Decode ERP metadata without reading or decompressing resource payloads. */
export function parseErpFile(buffer: Buffer): ErpFile {
  let pos = 0;
  const readUint32 = () => { const value = buffer.readUInt32LE(pos); pos += 4; return value; };
  const readInt32 = () => { const value = buffer.readInt32LE(pos); pos += 4; return value; };
  const readUint16 = () => { const value = buffer.readUInt16LE(pos); pos += 2; return value; };
  const readByte = () => buffer[pos++];
  const readUint64 = () => { const value = buffer.readBigUInt64LE(pos); pos += 8; return value; };
  const readBytes = (length: number) => { const value = buffer.subarray(pos, pos + length); pos += length; return value; };
  const readString = (length: number) => {
    const bytes = readBytes(length);
    const end = bytes.indexOf(0);
    return bytes.subarray(0, end < 0 ? length : end).toString("utf-8");
  };

  const magic = readUint32();
  if (magic !== ERP_MAGIC) throw new Error(`Invalid ERP magic: 0x${magic.toString(16)} (expected 0x${ERP_MAGIC.toString(16)})`);
  const version = readInt32();
  if (version < 0 || version > 4) throw new Error(`Unsupported ERP version: ${version}`);

  readBytes(8); // padding
  readBytes(8); // info offset
  readBytes(8); // info size
  const resourceOffset = readUint64();
  readBytes(8); // padding
  const numFiles = readInt32();
  const numTempFiles = readInt32();

  const resources: ErpResource[] = [];
  for (let i = 0; i < numFiles; i++) {
    readUint32(); // entry info length
    const identifier = readString(readUint16());
    const resourceType = readString(16);
    const unknown = readInt32();
    const unknown2 = version >= 4 ? readUint16() : 0;
    const fragmentCount = readByte();
    const fragments: ErpFragment[] = [];

    for (let j = 0; j < fragmentCount; j++) {
      const name = readString(4);
      const offset = readUint64();
      const size = readUint64();
      const flags = readInt32();
      let compression = 0;
      let packedSize = 0n;
      if (version > 2) {
        compression = readByte();
        packedSize = readUint64();
      }
      fragments.push({ name, offset, size, flags, compression, packedSize });
    }

    const hash = version > 2 ? new Uint8Array(readBytes(16)) : new Uint8Array(0);
    resources.push({ identifier, resourceType, unknown, unknown2, fragmentCount, fragments, hash });
  }

  return {
    header: { magic, version, resourceOffset, numFiles, numTempFiles },
    resources,
  };
}

export function matchingErpResources(erp: ErpFile, pattern: string): ErpResource[] {
  const normalized = pattern.toLowerCase();
  return erp.resources.filter((resource) => resource.identifier.toLowerCase().includes(normalized));
}

/** Read one fragment's stored bytes. Compression remains caller policy. */
export function readErpFragment(buffer: Buffer, resourceOffset: bigint, fragment: ErpFragment): Buffer {
  const dataOffset = Number(resourceOffset) + Number(fragment.offset);
  const dataSize = Number(fragment.packedSize || fragment.size);
  return buffer.subarray(dataOffset, dataOffset + dataSize);
}

/** Read stored bytes for all resources whose identifier contains pattern. */
export function extractMatchingErpFragments(buffer: Buffer, pattern: string): Array<{ resource: ErpResource; fragment: ErpFragment; data: Buffer }> {
  const erp = parseErpFile(buffer);
  return matchingErpResources(erp, pattern).flatMap((resource) =>
    resource.fragments.map((fragment) => ({
      resource,
      fragment,
      data: readErpFragment(buffer, erp.header.resourceOffset, fragment),
    })),
  );
}
