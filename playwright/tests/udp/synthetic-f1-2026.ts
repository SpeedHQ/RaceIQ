// SPECIFICATION-DERIVED FIXTURE, not a recording from F1 25's 2026 DLC.
// Re-encode the committed 2025 driving trace using EA's pinned 2026 structures.
// See docs/project-status/f1-2026-wire-audit.md. Keep this independent of the
// production decoder so parser offset mistakes cannot manufacture passing data.
const HEADER = 29;
const CARS_2025 = 22;
const CARS_2026 = 24;

function header(source: Buffer, bytes: number, id = source[6]): Buffer {
  if (source.readUInt16LE(0) !== 2025) throw new Error("Synthetic fixture requires 2025 source packets");
  const output = Buffer.alloc(bytes);
  source.copy(output, 0, 0, HEADER);
  output.writeUInt16LE(2026, 0);
  // Preserve F1 25's game year; wire format and installed game year differ.
  output[6] = id;
  // Preserve session boundaries without colliding with the original capture.
  output.writeBigUInt64LE(source.readBigUInt64LE(7) ^ (1n << 63n), 7);
  return output;
}

function cars(source: Buffer, stride: number, prefix = 0, suffix = 0): Buffer {
  const output = header(source, HEADER + prefix + CARS_2026 * stride + suffix);
  source.copy(output, HEADER, HEADER, HEADER + prefix + CARS_2025 * stride);
  if (suffix) source.copy(output, HEADER + prefix + CARS_2026 * stride, HEADER + prefix + CARS_2025 * stride);
  return output;
}

function convert(source: Buffer): Buffer | null {
  switch (source[6]) {
    case 0: {
      const output = header(source, 1325);
      for (let i = 0; i < CARS_2025; i++) {
        const from = HEADER + i * 60;
        const to = HEADER + i * 54;
        source.copy(output, to, from, from + 36);
        for (let axis = 0; axis < 3; axis++) {
          const g = Math.round(source.readFloatLE(from + 36 + axis * 4) * 1000);
          if (!Number.isFinite(g)) throw new Error("Non-finite source g-force in synthetic fixture");
          // The 2025 trace includes impact spikes outside int16 thousandths.
          // Saturate this synthetic encoding; never claim exact motion parity
          // for those spikes or treat it as evidence of EA's encoder behavior.
          output.writeInt16LE(Math.max(-32768, Math.min(32767, g)), to + 36 + axis * 2);
        }
        source.copy(output, to + 42, from + 48, from + 60);
      }
      return output;
    }
    case 1: {
      const output = header(source, 926);
      source.copy(output, HEADER, HEADER);
      output[HEADER + 8] = 13; // Synthetic 2026 formula; original timing stays intact.
      return output;
    }
    case 2:
      return cars(source, 57, 0, 2);
    case 4: {
      const output = header(source, 1470);
      output[HEADER] = source[HEADER];
      for (let i = 0; i < CARS_2025; i++) {
        const from = HEADER + 1 + i * 57;
        const to = HEADER + 1 + i * 60;
        output[to] = source[from];
        output.writeUInt16LE(source[from + 1], to + 1);
        output.writeUInt16LE(source[from + 2], to + 3);
        output.writeUInt16LE(source[from + 3], to + 5);
        source.copy(output, to + 7, from + 4, from + 39);
        source.copy(output, to + 42, from + 39, from + 57);
      }
      return output;
    }
    case 5:
      return cars(source, 50, 0, 4);
    case 6: {
      const output = header(source, 1448);
      for (let i = 0; i < CARS_2025; i++) {
        const from = HEADER + i * 60;
        const to = HEADER + i * 59;
        source.copy(output, to, from, from + 38);
        output.writeUInt8(source.readUInt16LE(from + 38), to + 38);
        source.copy(output, to + 39, from + 40, from + 60);
        output[to + 18] = 0; // Do not relabel the source car's DRS as active aero.
      }
      source.copy(output, HEADER + CARS_2026 * 59, HEADER + CARS_2025 * 60);
      return output;
    }
    case 7: {
      const output = header(source, 1445);
      for (let i = 0; i < CARS_2025; i++) {
        const from = HEADER + i * 55;
        const to = HEADER + i * 59;
        source.copy(output, to, from, from + 50);
        output[to + 22] = 0;
        output.writeUInt16LE(0, to + 23);
        output.writeFloatLE(8_000_000, to + 50); // Deliberate synthetic harvest limit.
        source.copy(output, to + 54, from + 50, from + 55);
      }
      return output;
    }
    case 8:
      return cars(source, 46, 1);
    case 10:
      return cars(source, 46);
    case 3:
    case 11:
    case 13: {
      const output = header(source, source.length);
      source.copy(output, HEADER, HEADER);
      return output;
    }
    // No production decoder consumes the other source packet types. Do not
    // fabricate 2026 layouts for those packets just to preserve packet count.
    default:
      return null;
  }
}

export function syntheticF1SeasonPackFrames(frames: readonly Buffer[]): Buffer[] {
  const result: Buffer[] = [];
  for (const source of frames) {
    const converted = convert(source);
    if (!converted) continue;
    result.push(converted);
    if (source[6] !== 6) continue;
    const extra = header(source, 269, 16);
    for (let i = 0; i < CARS_2025; i++) {
      const from = HEADER + i * 60;
      const to = HEADER + i * 10;
      const speed = source.readUInt16LE(from);
      const throttle = source.readFloatLE(from + 2);
      extra[to] = speed > 220 ? 1 : 0;
      extra[to + 1] = 1;
      extra.writeUInt16LE(120, to + 2);
      extra[to + 4] = 1;
      extra[to + 5] = speed > 200 && throttle > 0.9 ? 1 : 0;
      extra.writeUInt16LE(250, to + 6);
      extra[to + 8] = 1;
    }
    result.push(extra);
  }
  return result;
}
