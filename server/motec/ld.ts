/**
 * MoTeC i2 `.ld` log reader.
 *
 * Layout follows the community-reverse-engineered format (gotzl/ldparser),
 * verified byte-for-byte against an AC Evo export
 * (`Spa-mercedes_amg_gt3_evo-2-2024.12.15-09.59.54.ld`, 55 channels, 137.0 s).
 *
 * Structure:
 *   - fixed header (see offsets below)
 *   - singly-linked list of 124-byte channel-meta blocks starting at `metaPtr`
 *   - each block points at its own contiguous, little-endian sample array
 *
 * Sample data is float32 for every channel AC Evo writes (`dtypeA` 7 / `dtype` 4).
 * int16/int32 variants exist in other MoTeC exports and are handled too.
 */

const HEAD = {
  metaPtr: 8,
  eventPtr: 36,
  date: 94,
  time: 126,
  driver: 158,
  vehicleId: 222,
  venue: 350,
} as const;

const TEXT_DECODER = new TextDecoder("latin1");

/** Guard against a corrupt `nextPtr` sending us round a cycle forever. */
const MAX_CHANNELS = 4096;

/** Event block: 64s name, 64s session, 1024s comment, u16 venue_ptr. */
const EVENT = { name: 0, session: 64, comment: 128 } as const;

/** Channel-meta block field offsets. Block is 124 bytes total. */
const CHAN = {
  nextPtr: 4,
  dataPtr: 8,
  sampleCount: 12,
  dtypeA: 18,
  dtype: 20,
  freq: 22,
  shift: 24,
  mul: 26,
  scale: 28,
  decPlaces: 30,
  name: 32,
  shortName: 64,
  unit: 72,
} as const;

const STR_LEN = { name: 32, shortName: 8, unit: 12, head: 64, date: 16 } as const;
const CHANNEL_META_SIZE = 124;

export interface LdChannel {
  name: string;
  shortName: string;
  unit: string;
  /** Sample rate as declared in the file. May be wrong — see `effectiveFreq`. */
  declaredFreq: number;
  /**
   * Sample rate implied by `samples.length / logDuration`. AC Evo mislabels its
   * ECU channels (`EN_*`, `TIME`) as 50 Hz when they are actually logged at
   * 250 Hz, which would stretch them to 5x the log duration if believed.
   */
  effectiveFreq: number;
  samples: Float64Array;
}

export interface LdLog {
  /** Device type string, e.g. "ADL". */
  device: string;
  /** `DD/MM/YYYY` as written by the exporter. */
  date: string;
  /** `HH:MM:SS` as written by the exporter. */
  time: string;
  driver: string;
  vehicleId: string;
  venue: string;
  eventName: string;
  eventSession: string;
  eventComment: string;
  /** Log duration in seconds, taken as the modal channel duration. */
  duration: number;
  channels: LdChannel[];
}

function readString(buf: Uint8Array, offset: number, maxLen: number): string {
  if (offset + maxLen > buf.length) return "";
  const slice = buf.subarray(offset, offset + maxLen);
  const nul = slice.indexOf(0);
  return TEXT_DECODER.decode(nul === -1 ? slice : slice.subarray(0, nul)).trim();
}

function readSamples(
  view: DataView,
  dataPtr: number,
  count: number,
  dtypeA: number,
  dtype: number,
): Float64Array {
  // dtypeA 7 marks the float family; anything else is integer.
  const isFloat = dtypeA === 7;
  const width = isFloat ? (dtype === 2 ? 2 : 4) : dtype === 3 ? 4 : 2;
  const usable = Math.max(0, Math.min(count, Math.floor((view.byteLength - dataPtr) / width)));
  const out = new Float64Array(usable);
  for (let i = 0; i < usable; i++) {
    const at = dataPtr + i * width;
    out[i] = isFloat
      ? width === 4
        ? view.getFloat32(at, true)
        : view.getInt16(at, true) // float16 is vanishingly rare; read raw
      : width === 4
        ? view.getInt32(at, true)
        : view.getInt16(at, true);
  }
  return out;
}

/** Most common value in a list, within a relative tolerance. */
function modalDuration(durations: number[]): number {
  let best = durations[0] ?? 0;
  let bestCount = 0;
  for (const candidate of durations) {
    let count = 0;
    for (const duration of durations) {
      if (Math.abs(duration - candidate) <= candidate * 0.02) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

export function parseLd(buf: Uint8Array): LdLog {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const metaPtr = view.getUint32(HEAD.metaPtr, true);
  if (metaPtr === 0 || metaPtr >= buf.byteLength) {
    throw new Error("Not a MoTeC .ld file: channel metadata pointer is out of range");
  }

  const eventPtr = view.getUint32(HEAD.eventPtr, true);
  const hasEvent = eventPtr > 0 && eventPtr < buf.byteLength;

  // --- channels ---
  const raw: Array<Omit<LdChannel, "effectiveFreq">> = [];
  let ptr = metaPtr;
  const seen = new Set<number>();
  while (
    ptr > 0 &&
    ptr + CHANNEL_META_SIZE <= buf.byteLength &&
    !seen.has(ptr) &&
    raw.length < MAX_CHANNELS
  ) {
    seen.add(ptr);
    const count = view.getUint32(ptr + CHAN.sampleCount, true);
    const dataPtr = view.getUint32(ptr + CHAN.dataPtr, true);
    const freq = view.getUint16(ptr + CHAN.freq, true);
    const shift = view.getInt16(ptr + CHAN.shift, true);
    const mul = view.getInt16(ptr + CHAN.mul, true);
    const scale = view.getInt16(ptr + CHAN.scale, true);
    const dec = view.getInt16(ptr + CHAN.decPlaces, true);

    const samples = readSamples(
      view,
      dataPtr,
      count,
      view.getUint16(ptr + CHAN.dtypeA, true),
      view.getUint16(ptr + CHAN.dtype, true),
    );

    // MoTeC's documented decode: (raw / scale * 10^-dec + shift) * mul.
    // AC Evo writes the identity transform (scale=1, mul=1, shift=0, dec=0);
    // applying it anyway keeps other exporters honest.
    if (scale !== 1 || mul !== 1 || shift !== 0 || dec !== 0) {
      const safeScale = scale === 0 ? 1 : scale;
      const safeMul = mul === 0 ? 1 : mul;
      const decFactor = 10 ** -dec;
      for (let i = 0; i < samples.length; i++) {
        samples[i] = (samples[i]! / safeScale * decFactor + shift) * safeMul;
      }
    }

    raw.push({
      name: readString(buf, ptr + CHAN.name, STR_LEN.name),
      shortName: readString(buf, ptr + CHAN.shortName, STR_LEN.shortName),
      unit: readString(buf, ptr + CHAN.unit, STR_LEN.unit),
      declaredFreq: freq,
      samples,
    });

    ptr = view.getUint32(ptr + CHAN.nextPtr, true);
  }

  if (raw.length === 0) throw new Error("MoTeC .ld file contains no channels");

  // --- duration + per-channel rate correction ---
  const durations: number[] = [];
  for (const channel of raw) {
    if (channel.declaredFreq > 0 && channel.samples.length > 0) {
      durations.push(channel.samples.length / channel.declaredFreq);
    }
  }
  const duration = modalDuration(durations);

  const channels: LdChannel[] = raw.map((c) => {
    const declaredDuration = c.declaredFreq > 0 ? c.samples.length / c.declaredFreq : 0;
    const mislabelled = duration > 0 && Math.abs(declaredDuration - duration) > duration * 0.05;
    return {
      ...c,
      effectiveFreq: mislabelled && duration > 0 ? c.samples.length / duration : c.declaredFreq,
    };
  });

  return {
    device: readString(buf, 74, STR_LEN.shortName),
    date: readString(buf, HEAD.date, STR_LEN.date),
    time: readString(buf, HEAD.time, STR_LEN.date),
    driver: readString(buf, HEAD.driver, STR_LEN.head),
    vehicleId: readString(buf, HEAD.vehicleId, STR_LEN.head),
    venue: readString(buf, HEAD.venue, STR_LEN.head),
    eventName: hasEvent ? readString(buf, eventPtr + EVENT.name, STR_LEN.head) : "",
    eventSession: hasEvent ? readString(buf, eventPtr + EVENT.session, STR_LEN.head) : "",
    eventComment: hasEvent ? readString(buf, eventPtr + EVENT.comment, 256) : "",
    duration,
    channels,
  };
}

/** Case-insensitive channel lookup. */
export function findChannel(log: LdLog, name: string): LdChannel | undefined {
  const target = name.toLowerCase();
  return log.channels.find((c) => c.name.toLowerCase() === target);
}

