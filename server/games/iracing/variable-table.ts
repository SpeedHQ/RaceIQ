import type { IRacingValue } from "./source-frame";

export const IRSDK_VAR_HEADER_SIZE = 144;

export const IRSDKVariableType = {
  Char: 0,
  Bool: 1,
  Int: 2,
  BitField: 3,
  Float: 4,
  Double: 5,
} as const;

export type IRSDKVariableType =
  (typeof IRSDKVariableType)[keyof typeof IRSDKVariableType];

export interface IRacingVariableDescriptor {
  type: IRSDKVariableType;
  offset: number;
  count: number;
  countAsTime: boolean;
  name: string;
  description: string;
  unit: string;
}

function readCString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  const boundedEnd = end >= offset && end < offset + length ? end : offset + length;
  return buf.toString("utf8", offset, boundedEnd).trim();
}

function elementSize(type: IRSDKVariableType): number {
  switch (type) {
    case IRSDKVariableType.Char:
    case IRSDKVariableType.Bool:
      return 1;
    case IRSDKVariableType.Int:
    case IRSDKVariableType.BitField:
    case IRSDKVariableType.Float:
      return 4;
    case IRSDKVariableType.Double:
      return 8;
    default:
      return 0;
  }
}

export class IRacingVariableTable {
  private readonly descriptors = new Map<string, IRacingVariableDescriptor>();
  private readonly rowLength: number;

  constructor(headerBytes: Buffer, rowLength: number) {
    this.rowLength = rowLength;
    if (
      rowLength <= 0 ||
      headerBytes.length === 0 ||
      headerBytes.length % IRSDK_VAR_HEADER_SIZE !== 0
    ) {
      throw new Error("Invalid iRacing variable table");
    }

    for (let offset = 0; offset < headerBytes.length; offset += IRSDK_VAR_HEADER_SIZE) {
      const type = headerBytes.readInt32LE(offset) as IRSDKVariableType;
      const valueOffset = headerBytes.readInt32LE(offset + 4);
      const count = headerBytes.readInt32LE(offset + 8);
      const size = elementSize(type);
      const name = readCString(headerBytes, offset + 16, 32);

      if (
        !name ||
        size === 0 ||
        valueOffset < 0 ||
        count <= 0 ||
        count > 4096 ||
        valueOffset + size * count > rowLength
      ) {
        continue;
      }

      this.descriptors.set(name, {
        type,
        offset: valueOffset,
        count,
        countAsTime: headerBytes.readUInt8(offset + 12) !== 0,
        name,
        description: readCString(headerBytes, offset + 48, 64),
        unit: readCString(headerBytes, offset + 112, 32),
      });
    }
  }

  has(name: string): boolean {
    return this.descriptors.has(name);
  }

  getDescriptor(name: string): IRacingVariableDescriptor | undefined {
    return this.descriptors.get(name);
  }

  read(row: Buffer, name: string): IRacingValue | undefined {
    const descriptor = this.descriptors.get(name);
    if (!descriptor || row.length < this.rowLength) return undefined;

    if (descriptor.type === IRSDKVariableType.Char) {
      return readCString(row, descriptor.offset, descriptor.count);
    }

    const values: Array<number | boolean> = [];
    const stride = elementSize(descriptor.type);
    for (let index = 0; index < descriptor.count; index++) {
      const offset = descriptor.offset + index * stride;
      switch (descriptor.type) {
        case IRSDKVariableType.Bool:
          values.push(row.readUInt8(offset) !== 0);
          break;
        case IRSDKVariableType.Int:
          values.push(row.readInt32LE(offset));
          break;
        case IRSDKVariableType.BitField:
          values.push(row.readUInt32LE(offset));
          break;
        case IRSDKVariableType.Float:
          values.push(row.readFloatLE(offset));
          break;
        case IRSDKVariableType.Double:
          values.push(row.readDoubleLE(offset));
          break;
      }
    }

    return descriptor.count === 1 ? values[0] : values;
  }

  readSelected(row: Buffer, names: readonly string[]): Record<string, IRacingValue> {
    const values: Record<string, IRacingValue> = {};
    for (const name of names) {
      const value = this.read(row, name);
      const hasNonFiniteNumber =
        (typeof value === "number" && !Number.isFinite(value)) ||
        (Array.isArray(value) &&
          value.some((entry) => typeof entry === "number" && !Number.isFinite(entry)));
      if (value !== undefined && !hasNonFiniteNumber) values[name] = value;
    }
    return values;
  }
}
